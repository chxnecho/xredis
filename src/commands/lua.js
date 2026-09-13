'use strict';

// Lua scripting -- EVAL / EVALSHA / SCRIPT KILL / SCRIPT DEBUG.
const crypto = require('crypto');
const fengari = require('fengari');
const lua = fengari.lua;
const lauxlib = fengari.lauxlib;
const lualib = fengari.lualib;
const { toStr, err } = require('../util');
const P = require('../protocol');

const LUA_TSTRING = lua.LUA_TSTRING;
const LUA_TNUMBER = lua.LUA_TNUMBER;
const LUA_TBOOLEAN = lua.LUA_TBOOLEAN;
const LUA_TTABLE = lua.LUA_TTABLE;
const LUA_TNIL = lua.LUA_TNIL;
const LUA_TNONE = lua.LUA_TNONE;
const LUA_MULTRET = lua.LUA_MULTRET;
const LUA_OK = lua.LUA_OK;
const LUA_ERRERR = lua.LUA_ERRERR;

const scriptCache = new Map();

function sha1(body) {
  return crypto.createHash('sha1').update(Buffer.from(body, 'latin1')).digest('hex');
}

// ------------------------------ helpers

function newLuaState() {
  const L = lauxlib.luaL_newstate();
  if (!L) throw new Error('lua: cannot allocate state');
  // Each luaopen_* pushes the opened module table onto the stack; pop it so
  // the stack height below is deterministic for result extraction.
  lualib.luaopen_base(L); lua.lua_pop(L, 1);
  lualib.luaopen_table(L); lua.lua_pop(L, 1);
  lualib.luaopen_string(L); lua.lua_pop(L, 1);
  lualib.luaopen_math(L); lua.lua_pop(L, 1);
  return L;
}

function pushStr(L, s) {
  if (typeof s === 'string') s = Buffer.from(s, 'latin1');
  if (Buffer.isBuffer(s)) s = Uint8Array.from(s);
  lua.lua_pushlstring(L, s, s.length);
}

function popValue(L, idx) {
  idx = lua.lua_absindex(L, idx);
  const t = lua.lua_type(L, idx);
  switch (t) {
    case LUA_TNIL: case LUA_TNONE: return null;
    case LUA_TBOOLEAN: return lua.lua_toboolean(L, idx) !== 0;
    case LUA_TNUMBER: {
      const n = lua.lua_tonumber(L, idx);
      return (Number.isInteger(n) && Math.abs(n) <= 0x7fffffff) ? Math.round(n) : n;
    }
    case LUA_TSTRING: {
      const u8 = lua.lua_tolstring(L, idx, 0);
      return u8 ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : Buffer.alloc(0);
    }
    case LUA_TTABLE: return luaTableToJS(L, idx);
    default: return lua.lua_tojsstring(L, idx);
  }
}

function luaTableToJS(L, idx) {
  idx = lua.lua_absindex(L, idx);
  lua.lua_pushnil(L);
  const arr = [], obj = [];
  let i = 1;
  while (lua.lua_next(L, idx) !== 0) {
    const kt = lua.lua_type(L, -2);
    const v = popValue(L, -1);
    if (kt === LUA_TNUMBER) {
      const k = lua.lua_tointeger(L, -2);
      if (k === i) { arr.push(v); i++; lua.lua_pop(L, 1); continue; }
    }
    obj.push([popValue(L, -2), v]);
    lua.lua_pop(L, 1);
  }
  if (obj.length === 0 && arr.length > 0) return arr;
  if (arr.length === 0 && obj.length > 0) { const o={}; for (const [k,v] of obj) o[k]=v; return o; }
  const out = arr.slice();
  for (const [,v] of obj) out.push(v);
  return out;
}

const callFnRegistry = new Map();

function lua_getref(L, key) { return callFnRegistry.get('' + L + '::' + key) || null; }
function lua_setref(L, key, value) { callFnRegistry.set('' + L + '::' + key, value); }
function luaL_error(L, msg) { lua.lua_pushstring(L, msg); return lua.lua_error(L); }

// ------------------------------ redis.* globals

function setupRedisGlobals(L) {
  lua.lua_newtable(L);
  const rt = lua.lua_gettop(L);
  // redis.call
  lua.lua_pushcclosure(L, function (L) {
    const nargs = lua.lua_gettop(L); // closure args live at stack slots 1..nargs
    if (nargs < 1) return luaL_error(L, 'redis.call needs at least 1 arg');
    if (lua.lua_type(L, 1) !== LUA_TSTRING) return luaL_error(L, 'redis.call: first arg must be a string');
    const cmd = lua.lua_tojsstring(L, 1);
    const argv = [];
    for (let i = 2; i <= nargs; i++) argv.push(toRedisArg(L, i));
    lua.lua_settop(L, 0);
    try {
      const fn = lua_getref(L, '_xredis_call_fn');
      if (!fn) return luaL_error(L, 'redis.call: server not available');
      return pushReplyToLua(L, fn(cmd, argv));
    } catch (e) { return luaL_error(L, e.message || String(e)); }
  }, 0);
  lua.lua_setfield(L, rt, 'call');
  // redis.pcall
  lua.lua_pushcclosure(L, function (L) {
    const nargs = lua.lua_gettop(L);
    if (nargs < 1) { lua.lua_pushboolean(L,0); lua.lua_pushstring(L,'redis.pcall needs at least 1 arg'); return 2; }
    if (lua.lua_type(L, 1) !== LUA_TSTRING) { lua.lua_pushboolean(L,0); lua.lua_pushstring(L,'redis.pcall: first arg must be a string'); return 2; }
    const cmd = lua.lua_tojsstring(L, 1);
    const argv = [];
    for (let i = 2; i <= nargs; i++) argv.push(toRedisArg(L, i));
    lua.lua_settop(L, 0);
    try {
      const fn = lua_getref(L, '_xredis_call_fn');
      if (!fn) { lua.lua_pushboolean(L,0); lua.lua_pushstring(L,'redis.pcall: call fn not set'); return 2; }
      const reply = fn(cmd, argv);
      lua.lua_pushboolean(L, 1);
      return pushReplyToLua(L, reply) + 1;
    } catch (e) { lua.lua_pushboolean(L,0); lua.lua_pushstring(L, e.message || String(e)); return 2; }
  }, 0);
  lua.lua_setfield(L, rt, 'pcall');
  // redis.log
  lua.lua_pushcclosure(L, function (L) { lua.lua_pop(L, lua.lua_gettop(L)); lua.lua_pushnil(L); return 1; }, 0);
  lua.lua_setfield(L, rt, 'log');
  // redis.errorreply
  lua.lua_pushcclosure(L, function (L) {
    if (lua.lua_gettop(L) < 1) return luaL_error(L, 'redis.errorreply needs an argument');
    const msg = lua.lua_tojsstring(L, 1);
    lua.lua_pop(L, lua.lua_gettop(L));
    lua.lua_pushstring(L, 'ERR ' + msg);
    return lua.LUA_ERRERR;
  }, 0);
  lua.lua_setfield(L, rt, 'errorreply');
  lua.lua_setglobal(L, 'redis');
}

function pushReplyToLua(L, v) {
  if (v === null || v === undefined) { lua.lua_pushnil(L); return 1; }
  if (Buffer.isBuffer(v)) { pushStr(L, v); return 1; }
  if (typeof v === 'string') { pushStr(L, v); return 1; }
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) <= 0x7fffffff) lua.lua_pushinteger(L, v);
    else lua.lua_pushnumber(L, v);
    return 1;
  }
  if (typeof v === 'boolean') { lua.lua_pushboolean(L, v ? 1 : 0); return 1; }
  if (Array.isArray(v)) {
    lua.lua_createtable(L, v.length, 0);
    for (let i = 0; i < v.length; i++) { lua.lua_pushinteger(L, i+1); pushReplyToLua(L, v[i]); lua.lua_settable(L, -3); }
    return 1;
  }
  if (typeof v === 'object') {
    lua.lua_createtable(L, 0, 0);
    for (const k of Object.keys(v)) { lua.lua_pushstring(L, String(k)); pushReplyToLua(L, v[k]); lua.lua_settable(L, -3); }
    return 1;
  }
  lua.lua_pushstring(L, String(v));
  return 1;
}

function toRedisArg(L, idx) {
  idx = lua.lua_absindex(L, idx);
  const t = lua.lua_type(L, idx);
  switch (t) {
    case LUA_TNIL: case LUA_TNONE: return null;
    case LUA_TBOOLEAN: return lua.lua_toboolean(L, idx) ? 1 : 0;
    case LUA_TNUMBER: {
      const n = lua.lua_tonumber(L, idx);
      return (Number.isInteger(n) && Math.abs(n) <= 0x7fffffff) ? Math.round(n) : n;
    }
    case LUA_TSTRING: {
      const u8 = lua.lua_tolstring(L, idx, 0);
      return u8 ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : Buffer.alloc(0);
    }
    case LUA_TTABLE: return luaTableToJS(L, idx);
    default: return lua.lua_tojsstring(L, idx);
  }
}

// ------------------------------ runScript

function runScript(server, scriptBody, keys, argv, callFn) {
  const L = newLuaState();
  setupRedisGlobals(L);
  lua_setref(L, '_xredis_call_fn', callFn);
  // KEYS
  lua.lua_createtable(L, keys.length, 0);
  for (let i = 0; i < keys.length; i++) { lua.lua_pushinteger(L, i+1); pushStr(L, keys[i]); lua.lua_settable(L, -3); }
  lua.lua_setglobal(L, 'KEYS');
  // ARGV
  lua.lua_createtable(L, argv.length, 0);
  for (let i = 0; i < argv.length; i++) {
    lua.lua_pushinteger(L, i+1);
    const v = argv[i];
    if (v === null || v === undefined) lua.lua_pushnil(L);
    else if (Buffer.isBuffer(v) || typeof v === 'string') pushStr(L, v);
    else if (Number.isInteger(v)) lua.lua_pushinteger(L, v);
    else if (typeof v === 'number') lua.lua_pushnumber(L, v);
    else if (typeof v === 'boolean') lua.lua_pushboolean(L, v ? 1 : 0);
    else lua.lua_pushstring(L, String(v));
    lua.lua_settable(L, -3);
  }
  lua.lua_setglobal(L, 'ARGV');
  // load + call
  const code = Buffer.from(scriptBody, 'latin1');
  const loadRc = lauxlib.luaL_loadbuffer(L, code, code.length, '=(evalscript)');
  if (loadRc !== LUA_OK) {
    const errMsg = lua.lua_tojsstring(L, -1) || 'unknown load error';
    lua.lua_pop(L, 1); lua.lua_close(L);
    return { ok: false, err: errMsg };
  }
  // lua_pcall returns the status code (lua_call does not) and, on error,
  // pushes the error message on the stack. The chunk function sits at
  // [base+1]; results replace it, occupying [base+1 .. top].
  const base = lua.lua_gettop(L) - 1;
  const callRc = lua.lua_pcall(L, 0, LUA_MULTRET, 0);
  if (callRc !== LUA_OK) {
    const errMsg = lua.lua_tojsstring(L, -1) || 'unknown runtime error';
    lua.lua_pop(L, 1); lua.lua_close(L);
    return { ok: false, err: errMsg };
  }
  const returns = [];
  for (let i = base + 1; i <= lua.lua_gettop(L); i++) returns.push(popValue(L, i));
  lua.lua_close(L);
  return { ok: true, returns };
}

// ------------------------------ command handlers

function cmdEval(server, argv, ctx) {
  // EVAL <script> <numkeys> [key ...] [arg ...]
  if (argv.length < 3) throw err("wrong number of arguments for 'eval' command");
  const script = toStr(argv[1]);
  const numKeys = parseInt(toStr(argv[2]));
  if (!Number.isFinite(numKeys) || numKeys < 0) throw err('number of keys can not be negative');
  if (!script) throw err('empty script');
  const keys = [];
  for (let i = 0; i < numKeys && 3 + i < argv.length; i++) keys.push(toStr(argv[3 + i]));
  const argv2 = [];
  for (let i = 3 + numKeys; i < argv.length; i++) argv2.push(argv[i]);
  const sha = sha1(script);
  if (!scriptCache.has(sha)) scriptCache.set(sha, { body: script });
  const callFn = (cmdName, args) => serverExecuteCommand(server, cmdName, args, ctx);
  const result = runScript(server, script, keys, argv2, callFn);
  if (!result.ok) throw err(result.err);
  return luaReturnsToReply(ctx, result.returns);
}

function cmdEvalSha(server, argv, ctx) {
  // EVALSHA <sha1> <numkeys> [key ...] [arg ...]
  if (argv.length < 3) throw err("wrong number of arguments for 'evalsha' command");
  const sha = toStr(argv[1]).toLowerCase();
  const cached = scriptCache.get(sha);
  if (!cached) throw err('NOSCRIPT No matching script. Please use EVAL instead');
  const numKeys = parseInt(toStr(argv[2]));
  if (!Number.isFinite(numKeys) || numKeys < 0) throw err('number of keys can not be negative');
  const keys = [];
  for (let i = 0; i < numKeys && 3 + i < argv.length; i++) keys.push(toStr(argv[3 + i]));
  const argv2 = [];
  for (let i = 3 + numKeys; i < argv.length; i++) argv2.push(argv[i]);
  const callFn = (cmdName, args) => serverExecuteCommand(server, cmdName, args, ctx);
  const result = runScript(server, cached.body, keys, argv2, callFn);
  if (!result.ok) throw err(result.err);
  return luaReturnsToReply(ctx, result.returns);
}

function serverExecuteCommand(server, cmdName, args, ctx) {
  const cmdNameLc = toStr(cmdName).toLowerCase();
  const cmd = server.commands.get(cmdNameLc);
  if (!cmd) throw new Error('NOSCRIPT No matching script. Please use EVAL instead');
  const argvBuf = [Buffer.from(cmdNameLc, 'latin1')];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === null || a === undefined) argvBuf.push(null);
    else if (Buffer.isBuffer(a)) argvBuf.push(a);
    else argvBuf.push(Buffer.from(String(a), 'latin1'));
  }
  const fakeCtx = {
    server, dbIdx: ctx.dbIdx, proto: ctx.proto,
    // Note: handlers build the ENCODED reply; decodeReplyToJS then turns it
    // into a JS value for Lua. Every method here must produce a complete,
    // parseable RESP frame.
    arr(parts) { return P.encArr(parts); },
    bulk(v) { return v === null ? P.encNull() : P.encBulk(v); },
    int(n) { return P.encInt(n); },
    status(s) { return P.encSimple(s); },
    ok() { return P.encSimple('OK'); },
    errLike(s) { return P.encError(s); },
    nil() { return P.encNull(); },
    nilArr() { return P.encNullArray(); },
    double(n) { return P.encDouble(n); },
    bool(b) { return P.encBool(b); },
    push(parts) { return P.encPush(parts); },
    map(pairs) { return P.encMap(pairs); },
    set(parts) { return P.encSet(parts); },
    verbatim(fmt, data) { return P.encVerbatim(fmt, data); },
  };
  const reply = cmd.handler(server, argvBuf, fakeCtx, server.virtualClient);
  return decodeReplyToJS(reply);
}

function decodeReplyToJS(reply) {
  if (Buffer.isBuffer(reply)) reply = Buffer.from(reply);
  else if (Array.isArray(reply)) reply = P.encArr(reply);
  else if (reply === null || reply === undefined) reply = P.encNull();
  else reply = Buffer.from(String(reply), 'latin1');
  const { RespParser } = require('../protocol');
  const parser = new RespParser();
  parser.feed(reply);
  const frames = parser.parse();
  if (frames.length === 0) return null;
  return decodeValue(frames[0]);
}

function decodeValue(frame) {
  if (!frame || !frame.t) return null;
  const t = frame.t;
  if (t === '*') { if (frame.a.length === 0) return []; const out=[]; for (const v of frame.a) out.push(decodeValue(v)); return out; }
  if (t === '$') return frame.b;
  if (t === ':') return frame.n;
  if (t === '+') return frame.s;
  if (t === '-') return frame.s;
  if (t === '#') return frame.b;
  if (t === ',') return frame.d;
  if (t === '_') return null;
  if (t === '~') { const s=[]; for (const v of frame.a) s.push(decodeValue(v)); return s; }
  if (t === '%') { const o={}; for (let i=0;i<frame.a.length;i+=2){ const k=decodeValue(frame.a[i]); const v=decodeValue(frame.a[i+1]); o[k]=v; } return o; }
  if (t === '>') { const out=[]; for (const v of frame.a) out.push(decodeValue(v)); return out; }
  if (frame.b) return frame.b.toString('latin1');
  return null;
}

function luaReturnsToReply(ctx, returns) {
  if (returns.length === 0) return ctx.nil();
  if (returns.length === 1) return toReply(ctx, returns[0]);
  return ctx.arr(returns.map(v => toReplyPart(ctx, v)));
}

function toReply(ctx, v) {
  if (v === null || v === undefined) return ctx.nil();
  if (Buffer.isBuffer(v)) return ctx.bulk(v);
  if (typeof v === 'string') return ctx.bulk(Buffer.from(v, 'latin1'));
  if (typeof v === 'number') { if (Number.isInteger(v)) return ctx.int(v); return ctx.double(v); }
  if (typeof v === 'boolean') return ctx.bool(v);
  if (Array.isArray(v)) return ctx.arr(v.map(x => toReplyPart(ctx, x)));
  if (typeof v === 'object') {
    const pairs = [];
    for (const k of Object.keys(v)) pairs.push(P.encBulk(Buffer.from(String(k),'latin1')), toReplyPart(ctx, v[k]));
    return ctx.map(pairs);
  }
  return ctx.bulk(Buffer.from(String(v), 'latin1'));
}

function toReplyPart(ctx, v) {
  if (v === null || v === undefined) return P.encNull();
  if (Buffer.isBuffer(v)) return P.encBulk(v);
  if (typeof v === 'string') return P.encBulk(Buffer.from(v, 'latin1'));
  if (typeof v === 'number') { if (Number.isInteger(v)) return P.encInt(v >>> 0); return P.encDouble(v); }
  if (typeof v === 'boolean') return P.encBool(v);
  if (Array.isArray(v)) return P.encArr(v.map(x => toReplyPart(ctx, x)));
  if (typeof v === 'object') {
    const pairs = [];
    for (const k of Object.keys(v)) pairs.push(P.encBulk(Buffer.from(String(k),'latin1')), toReplyPart(ctx, v[k]));
    return P.encMap(pairs);
  }
  return P.encBulk(Buffer.from(String(v), 'latin1'));
}

// ------------------------------ SCRIPT commands

function cmdScript(server, argv, ctx) {
  const sub = toStr(argv[1]).toLowerCase();
  if (sub === 'load') {
    if (argv.length < 3) throw err("wrong number of arguments for 'script|load' command");
    const body = toStr(argv[2]);
    if (!body) throw err('empty script');
    const sha = sha1(body);
    scriptCache.set(sha, { body });
    return ctx.bulk(Buffer.from(sha, 'latin1'));
  }
  if (sub === 'exists') {
    const shas = [];
    for (let i = 2; i < argv.length; i++) shas.push(scriptCache.has(toStr(argv[i]).toLowerCase()) ? 1 : 0);
    return shas.length === 0 ? ctx.arr([]) : ctx.arr(shas.map(v => P.encInt(v)));
  }
  if (sub === 'flush') { scriptCache.clear(); return ctx.int(1); }
  if (sub === 'kill') { return ctx.int(1); }
  if (sub === 'debug') { return ctx.int(1); }
  throw err('unknown script subcommand \'' + toStr(argv[1]) + '\'');
}

module.exports = { cmdEval, cmdEvalSha, cmdScript, sha1, scriptCache };

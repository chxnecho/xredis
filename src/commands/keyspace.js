'use strict';

// Generic / keyspace commands: DEL, EXISTS, EXPIRE family, TTL, PERSIST,
// KEYS, SCAN, TYPE, RENAME, RANDOMKEY, TOUCH, UNLINK, COPY, SELECT...

const { toStr, toBuf, parseIntArg, globMatch, err } = require('../util');
const P = require('../protocol');
const { StrVal } = require('../store/objects');

// EXPIRE/PExpire/ExpireAt/PExpireAt share one implementation. Redis 7 added
// the NX/XX/GT/LT condition options (mutually exclusive):
//   NX — set TTL only when the key currently has none
//   XX — set TTL only when the key currently has one
//   GT — set TTL only when the new TTL is greater than the current one
//   LT — set TTL only when the new TTL is smaller than the current one
// When the condition fails, the command is a no-op (reply 0). GT/LT compare
// absolute millisecond timestamps; a key without TTL counts as "no expiry"
// (GT always fails against it, LT always succeeds).
function expCmd(mult, atNotDelta) {
  return function cmdExpire(server, argv, ctx) {
    const db = server.db;
    const key = toStr(argv[1]);
    const val = parseIntArg(argv[2]);
    let nx = false, xx = false, gt = false, lt = false;
    for (let i = 3; i < argv.length; i++) {
      const opt = toStr(argv[i]).toUpperCase();
      const next = { NX: () => nx = true, XX: () => xx = true, GT: () => gt = true, LT: () => lt = true }[opt];
      if (!next) throw err('Unsupported option ' + toStr(argv[i]));
      next();
    }
    if (nx && (xx || gt || lt)) throw err('NX and XX, GT or LT options at the same time are not compatible');
    if ((gt && lt) || (nx && gt) || (nx && lt)) throw err('NX and XX, GT or LT options at the same time are not compatible');
    const now = Date.now();
    if (db.lookup(key, now) === null) { ctx.noPropagate = true; return ctx.int(0); }
    const hasTtl = db.expires.has(key);
    const cur = hasTtl ? db.expires.get(key) : Infinity;
    const ms = atNotDelta ? val * mult : now + val * mult;
    if (nx && hasTtl) { ctx.noPropagate = true; return ctx.int(0); }
    if (xx && !hasTtl) { ctx.noPropagate = true; return ctx.int(0); }
    if (gt && (cur >= ms)) { ctx.noPropagate = true; return ctx.int(0); }
    if (lt && (cur <= ms)) { ctx.noPropagate = true; return ctx.int(0); }
    if (ms <= now) {
      db.del(key);
      return ctx.int(1);
    }
    db.expires.set(key, ms);
    return ctx.int(1);
  };
}

const cmdExpire = expCmd(1000, false);
const cmdPExpire = expCmd(1, false);
const cmdExpireAt = expCmd(1000, true);
const cmdPExpireAt = expCmd(1, true);

function ttlImpl(server, argv, ctx, msPrecision) {
  const db = server.db;
  const key = toStr(argv[1]);
  const now = Date.now();
  if (db.lookup(key, now) === null) return ctx.int(-2);
  const ms = db.getTTL(key, now);
  if (ms === -2) return ctx.int(-2);
  const res = ms === -1 ? -1 : (msPrecision ? ms : Math.ceil(ms / 1000));
  return ctx.int(res);
}

function cmdTTL(server, argv, ctx) { return ttlImpl(server, argv, ctx, false); }
function cmdPTTL(server, argv, ctx) { return ttlImpl(server, argv, ctx, true); }

function cmdPersist(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const now = Date.now();
  if (db.lookup(key, now) === null) return ctx.int(0);
  return ctx.int(db.persist(key, now) ? 1 : 0);
}

function cmdDel(server, argv, ctx) {
  const db = server.db;
  let n = 0;
  for (let i = 1; i < argv.length; i++) {
    const key = toStr(argv[i]);
    if (db.lookup(key) !== null) { db.del(key); n++; }
  }
  return ctx.int(n);
}

function cmdUnlink(server, argv, ctx) { return cmdDel(server, argv, ctx); }

function cmdExists(server, argv, ctx) {
  const db = server.db;
  let n = 0;
  for (let i = 1; i < argv.length; i++) {
    if (db.lookup(toStr(argv[i])) !== null) n++;
  }
  return ctx.int(n);
}

function cmdType(server, argv, ctx) {
  const obj = server.db.lookup(toStr(argv[1]));
  const names = { string: 'string', list: 'list', hash: 'hash', set: 'set', zset: 'zset' };
  return ctx.status(obj ? (names[obj.type] || 'none') : 'none');
}

function cmdDbsize(server, argv, ctx) {
  return ctx.int(server.db.size);
}

function cmdFlushDb(server, argv, ctx) {
  server.db.flush();
  return ctx.ok();
}

function cmdFlushAll(server, argv, ctx) {
  server.db.flushAll();
  return ctx.ok();
}

function cmdKeys(server, argv, ctx) {
  const db = server.db;
  const pattern = toStr(argv[1]);
  const keys = db.allKeys().filter((k) => globMatch(pattern, k));
  return ctx.arr(keys.map((k) => P.encBulk(toBuf(k))));
}

function cmdScan(server, argv, ctx) {
  const db = server.db;
  const cursor = parseIntArg(argv[1]);
  if (cursor < 0) throw err('invalid cursor');
  let match = null, count = 10;
  for (let i = 2; i < argv.length; i++) {
    const opt = toStr(argv[i]).toUpperCase();
    if (opt === 'MATCH' && i + 1 < argv.length) { match = toStr(argv[++i]); }
    else if (opt === 'COUNT' && i + 1 < argv.length) { count = parseIntArg(argv[++i]); }
    else if (opt === 'TYPE' && i + 1 < argv.length) { i++; }
    else throw err('syntax error');
  }
  const keys = db.allKeys();
  const endIdx = Math.max(cursor, Math.min(keys.length, cursor + count));
  const out = [];
  for (let i = cursor; i < endIdx; i++) {
    const k = keys[i];
    if (match && !globMatch(match, k)) continue;
    out.push(P.encBulk(toBuf(k)));
  }
  const nextCursor = endIdx >= keys.length ? 0 : endIdx;
  return ctx.arr([P.encBulk(Buffer.from(String(nextCursor), 'latin1')), P.encArr(out)]);
}

function cmdRandomKey(server, argv, ctx) {
  const k = server.db.randomKey(Math.random);
  return ctx.bulk(k === null ? null : toBuf(k));
}

function cmdRename(server, argv, ctx) { return renameImpl(server, argv, ctx, false); }
function cmdRenameNX(server, argv, ctx) { return renameImpl(server, argv, ctx, true); }

function renameImpl(server, argv, ctx, nx) {
  const db = server.db;
  const src = toStr(argv[1]);
  const dst = toStr(argv[2]);
  const now = Date.now();
  const obj = db.lookup(src, now);
  if (!obj) throw err('no such key');
  if (nx && db.lookup(dst, now) !== null) return ctx.int(0);
  db.del(dst);
  const ttl = db.expires.get(src);
  db.set(dst, obj);
  db.del(src);
  if (ttl !== undefined) { db.expires.delete(src); db.expires.set(dst, ttl); }
  return nx ? ctx.int(1) : ctx.ok();
}

function cmdTouch(server, argv, ctx) {
  let n = 0;
  for (let i = 1; i < argv.length; i++) {
    if (server.db.lookup(toStr(argv[i])) !== null) n++;
  }
  return ctx.int(n);
}

function cmdSelect(server, argv, ctx, client) {
  const idx = parseIntArg(argv[1]);
  if (idx < 0 || idx >= server.keyspace.dbs.length) throw err('DB index is out of range');
  server.keyspace.selected = idx;
  if (client) client.dbIdx = idx;
  return ctx.ok();
}

function cmdCopy(server, argv, ctx) {
  const db = server.db;
  const src = toStr(argv[1]);
  const dst = toStr(argv[2]);
  let replace = false;
  for (let i = 3; i < argv.length; i++) {
    const opt = toStr(argv[i]).toUpperCase();
    if (opt === 'REPLACE') replace = true;
    else if (opt === 'DB') i++;
    else throw err('syntax error');
  }
  const now = Date.now();
  const obj = db.lookup(src, now);
  if (!obj) return ctx.int(0);
  if (!replace && db.lookup(dst, now) !== null) return ctx.int(0);
  const clone = cloneObj(obj);
  db.set(dst, clone);
  const ttl = db.expires.get(src);
  if (ttl !== undefined) db.expires.set(dst, ttl);
  return ctx.int(1);
}

function cloneObj(obj) {
  const t = obj.type;
  if (t === 'string') return new StrVal(Buffer.from(obj.buf));
  const { ListVal, HashVal, SetVal, ZSetVal } = require('../store/objects');
  if (t === 'list') { const l = new ListVal(); for (const v of obj.list.toArray()) l.list.pushRight(v); return l; }
  if (t === 'hash') { const h = new HashVal(); for (const [k, v] of obj.map) h.map.set(k, Buffer.from(v)); return h; }
  if (t === 'set') { const s = new SetVal(); for (const m of obj.members()) s.add(m); return s; }
  if (t === 'zset') { const z = new ZSetVal(); for (const { member, score } of obj.sl.toArray()) z.add(member, score); return z; }
  throw new Error(`bad type ${t}`);
}

module.exports = {
  cmdExpire, cmdPExpire, cmdExpireAt, cmdPExpireAt,
  cmdTTL, cmdPTTL, cmdPersist, cmdDel, cmdUnlink, cmdExists, cmdType,
  cmdDbsize, cmdFlushDb, cmdFlushAll, cmdKeys, cmdScan,
  cmdRandomKey, cmdRename, cmdRenameNX, cmdTouch, cmdSelect, cmdCopy,
};
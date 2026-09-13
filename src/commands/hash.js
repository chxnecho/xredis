'use strict';

// Hash commands: HSET/GET family, HDEL, HINCRBY, HLEN, HKEYS/HVALS/HGETALL,
// HSCAN, HRANDFIELD, HMGET.

const { toStr, parseIntArg, parseFloatArg, formatDouble, err, wrongType } = require('../util');
const P = require('../protocol');
const { HashVal } = require('../store/objects');

function getHash(server, key) {
  const obj = server.db.lookup(key);
  if (!obj) return null;
  if (obj.type !== 'hash') throw wrongType();
  return obj;
}

function cmdHSet(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  if ((argv.length - 2) % 2 !== 0) throw err("wrong number of arguments for 'hset' command");
  let h = getHash(server, key);
  if (!h) { h = new HashVal(); db.set(key, h); }
  let added = 0;
  for (let i = 2; i < argv.length; i += 2) {
    const f = toStr(argv[i]);
    if (!h.map.has(f)) added++;
    h.map.set(f, argv[i + 1]);
  }
  return ctx.int(added);
}

function cmdHSetNX(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const field = toStr(argv[2]);
  let h = getHash(server, key);
  if (!h) { h = new HashVal(); db.set(key, h); }
  if (h.map.has(field)) return ctx.int(0);
  h.map.set(field, argv[3]);
  return ctx.int(1);
}

function cmdHGet(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  if (!h) return ctx.nil();
  const v = h.map.get(toStr(argv[2]));
  return ctx.bulk(v === undefined ? null : v);
}

function cmdHMGet(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  const parts = [];
  for (let i = 2; i < argv.length; i++) {
    const v = h ? h.map.get(toStr(argv[i])) : undefined;
    parts.push(v === undefined ? P.encNull() : P.encBulk(v));
  }
  return ctx.arr(parts);
}

function cmdHDel(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  if (!h) return ctx.int(0);
  let n = 0;
  for (let i = 2; i < argv.length; i++) {
    if (h.map.delete(toStr(argv[i]))) n++;
  }
  if (h.map.size === 0) server.db.del(toStr(argv[1]));
  return ctx.int(n);
}

function cmdHLen(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  return ctx.int(h ? h.map.size : 0);
}

function cmdHExists(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  return ctx.int(h && h.map.has(toStr(argv[2])) ? 1 : 0);
}

function cmdHKeys(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  if (!h) return ctx.arr([]);
  return ctx.arr(Array.from(h.map.keys()).map((k) => P.encBulk(Buffer.from(k, 'latin1'))));
}

function cmdHVals(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  if (!h) return ctx.arr([]);
  return ctx.arr(Array.from(h.map.values()).map((v) => P.encBulk(v)));
}

function cmdHGetAll(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  if (!h) return ctx.arr([]);
  const parts = [];
  for (const [k, v] of h.map) {
    parts.push(P.encBulk(Buffer.from(k, 'latin1')), P.encBulk(v));
  }
  return ctx.arr(parts);
}

function cmdHIncrBy(server, argv, ctx) {
  return hIncrImpl(server, argv, ctx, parseIntArg(argv[3]));
}

function cmdHIncrByFloat(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const field = toStr(argv[2]);
  const incr = parseFloatArg(argv[3]);
  let h = getHash(server, key);
  if (!h) { h = new HashVal(); db.set(key, h); }
  const cur = h.map.has(field) ? h.map.get(field).toString('latin1') : '0';
  if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(cur)) throw err('hash value is not a float');
  const next = formatDouble(Number(cur) + incr);
  if (next === 'NaN' || next === 'Infinity' || next === '-Infinity') throw err('increment would produce NaN or Infinity');
  const buf = Buffer.from(next, 'latin1');
  h.map.set(field, buf);
  return ctx.bulk(buf);
}

function hIncrImpl(server, argv, ctx, delta) {
  const db = server.db;
  const key = toStr(argv[1]);
  const field = toStr(argv[2]);
  let h = getHash(server, key);
  if (!h) { h = new HashVal(); db.set(key, h); }
  let cur = 0;
  if (h.map.has(field)) {
    const s = h.map.get(field).toString('latin1');
    if (!/^-?\d+$/.test(s)) throw err('hash value is not an integer');
    cur = Number(s);
  }
  const next = cur + delta;
  if (!Number.isSafeInteger(next)) throw err('increment or decrement would overflow');
  h.map.set(field, Buffer.from(String(next), 'latin1'));
  return ctx.int(next);
}

function hashScan(server, argv, ctx) {
  const key = toStr(argv[1]);
  const cursor = parseIntArg(argv[2]);
  let match = null, count = 10;
  for (let i = 3; i < argv.length; i++) {
    const opt = toStr(argv[i]).toUpperCase();
    if (opt === 'MATCH' && i + 1 < argv.length) match = toStr(argv[++i]);
    else if (opt === 'COUNT' && i + 1 < argv.length) count = parseIntArg(argv[++i]);
    else if (opt === 'NOVALUES') { }
    else throw err('syntax error');
  }
  const h = getHash(server, key);
  if (!h) return ctx.arr([P.encBulk(Buffer.from('0', 'latin1')), P.encArr([])]);
  const fields = Array.from(h.map.keys());
  const endIdx = Math.min(fields.length, cursor + count);
  const out = [];
  for (let i = cursor; i < endIdx; i++) {
    const f = fields[i];
    if (match && !require('../util').globMatch(match, f)) continue;
    out.push(P.encBulk(Buffer.from(f, 'latin1')), P.encBulk(h.map.get(f)));
  }
  const next = endIdx >= fields.length ? 0 : endIdx;
  return ctx.arr([P.encBulk(Buffer.from(String(next), 'latin1')), P.encArr(out)]);
}

function cmdHStrlen(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  if (!h) return ctx.int(0);
  const v = h.map.get(toStr(argv[2]));
  return ctx.int(v ? v.length : 0);
}

function cmdHRandField(server, argv, ctx) {
  const h = getHash(server, toStr(argv[1]));
  if (!h) {
    return argv.length > 3 ? ctx.nilArr() : ctx.nil();
  }
  const withValues = argv.length > 3 && toStr(argv[3]).toUpperCase() === 'WITHVALUES';
  const countArg = argv.length > 2;
  if (!countArg) {
    const ks = Array.from(h.map.keys());
    const k = ks[Math.floor(Math.random() * ks.length)];
    return ctx.bulk(Buffer.from(k, 'latin1'));
  }
  const count = parseIntArg(argv[2]);
  const fields = Array.from(h.map.keys());
  if (count >= 0) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const k = fields[Math.floor(Math.random() * fields.length)];
      out.push(P.encBulk(Buffer.from(k, 'latin1')));
      if (withValues) out.push(P.encBulk(h.map.get(k)));
    }
    return ctx.arr(out);
  }
  const n = Math.min(-count, fields.length);
  const copy = fields.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    const t = copy[i]; copy[i] = copy[j]; copy[j] = t;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = copy[i];
    out.push(P.encBulk(Buffer.from(k, 'latin1')));
    if (withValues) out.push(P.encBulk(h.map.get(k)));
  }
  return ctx.arr(out);
}

module.exports = {
  cmdHSet, cmdHSetNX, cmdHGet, cmdHMGet, cmdHDel, cmdHLen, cmdHExists,
  cmdHKeys, cmdHVals, cmdHGetAll, cmdHIncrBy, cmdHIncrByFloat, hashScan, cmdHStrlen,
  cmdHRandField,
};
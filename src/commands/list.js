'use strict';

// List commands: LPUSH/RPUSH/POP family, LRANGE, LINDEX, LINSERT, LREM,
// LSET, LTRIM, LLEN, LMOVE.

const { toStr, parseIntArg, normIndex, err, wrongType } = require('../util');
const P = require('../protocol');
const { ListVal } = require('../store/objects');

function getList(server, key) {
  const obj = server.db.lookup(key);
  if (!obj) return null;
  if (obj.type !== 'list') throw wrongType();
  return obj;
}

function cmdLPush(server, argv, ctx) { return push(server, argv, ctx, 'left'); }
function cmdRPush(server, argv, ctx) { return push(server, argv, ctx, 'right'); }

function push(server, argv, ctx, dir) {
  const db = server.db;
  const key = toStr(argv[1]);
  let l = getList(server, key);
  if (!l) { l = new ListVal(); db.set(key, l); }
  for (let i = 2; i < argv.length; i++) {
    if (dir === 'left') l.list.pushLeft(argv[i]);
    else l.list.pushRight(argv[i]);
  }
  return ctx.int(l.list.length);
}

function cmdLPushX(server, argv, ctx) { return pushX(server, argv, ctx, 'left'); }
function cmdRPushX(server, argv, ctx) { return pushX(server, argv, ctx, 'right'); }

function pushX(server, argv, ctx, dir) {
  const l = getList(server, toStr(argv[1]));
  if (!l) return ctx.int(0);
  for (let i = 2; i < argv.length; i++) {
    if (dir === 'left') l.list.pushLeft(argv[i]);
    else l.list.pushRight(argv[i]);
  }
  return ctx.int(l.list.length);
}

function cmdLPop(server, argv, ctx) { return pop(server, argv, ctx, 'left', false); }
function cmdRPop(server, argv, ctx) { return pop(server, argv, ctx, 'right', false); }
function cmdLPopCount(server, argv, ctx) { return pop(server, argv, ctx, 'left', true); }
function cmdRPopCount(server, argv, ctx) { return pop(server, argv, ctx, 'right', true); }

function pop(server, argv, ctx, dir, withCount) {
  const db = server.db;
  const key = toStr(argv[1]);
  const l = getList(server, key);
  if (!l) return withCount ? ctx.nilArr() : ctx.nil();
  const count = withCount ? parseIntArg(argv[2]) : 1;
  if (count < 0) throw err('value is out of range, must be positive');
  if (count === 0) return ctx.arr([]);
  const out = [];
  for (let i = 0; i < count && l.list.length > 0; i++) {
    out.push(dir === 'left' ? l.list.popLeft() : l.list.popRight());
  }
  if (l.list.length === 0) db.del(key);
  if (withCount) return ctx.arr(out.map((v) => P.encBulk(v)));
  return ctx.bulk(out[0]);
}

function cmdLLen(server, argv, ctx) {
  const l = getList(server, toStr(argv[1]));
  return ctx.int(l ? l.list.length : 0);
}

function cmdLRange(server, argv, ctx) {
  const l = getList(server, toStr(argv[1]));
  if (!l) return ctx.arr([]);
  const len = l.list.length;
  let s = normIndex(parseIntArg(argv[2]), len);
  let e = normIndex(parseIntArg(argv[3]), len);
  if (s < 0) s = 0;
  if (e >= len) e = len - 1;
  if (s > e || s >= len || e < 0) return ctx.arr([]);
  const parts = [];
  let node = l.list.nodeAt(s);
  for (let i = s; i <= e && node; i++) {
    parts.push(P.encBulk(node.v));
    node = node.next;
  }
  return ctx.arr(parts);
}

function cmdLIndex(server, argv, ctx) {
  const l = getList(server, toStr(argv[1]));
  if (!l) return ctx.nil();
  const idx = normIndex(parseIntArg(argv[2]), l.list.length);
  if (idx < 0 || idx >= l.list.length) return ctx.nil();
  return ctx.bulk(l.list.nodeAt(idx).v);
}

function cmdLSet(server, argv, ctx) {
  const l = getList(server, toStr(argv[1]));
  if (!l) throw err('no such key');
  const idx = normIndex(parseIntArg(argv[2]), l.list.length);
  if (idx < 0 || idx >= l.list.length) throw err('index out of range');
  l.list.nodeAt(idx).v = argv[3];
  return ctx.ok();
}

function cmdLInsert(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const where = toStr(argv[2]).toUpperCase();
  const pivot = toStr(argv[3]);
  const value = argv[4];
  if (where !== 'BEFORE' && where !== 'AFTER') throw err('syntax error');
  const l = getList(server, key);
  if (!l) return ctx.int(0);
  let node = l.list.head;
  while (node && toStr(node.v) !== pivot) node = node.next;
  if (!node) return ctx.int(-1);
  if (where === 'BEFORE') l.list.insertBefore(node, value);
  else l.list.insertAfter(node, value);
  return ctx.int(l.list.length);
}

function cmdLRem(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const count = parseIntArg(argv[2]);
  const target = argv[3];
  const l = getList(server, key);
  if (!l) return ctx.int(0);
  let removed = 0;
  const targetStr = toStr(target);
  if (count >= 0) {
    let node = l.list.head;
    const limit = count === 0 ? Infinity : count;
    while (node && removed < limit) {
      const next = node.next;
      if (toStr(node.v) === targetStr) { l.list.remove(node); removed++; }
      node = next;
    }
  } else {
    const need = -count;
    let node = l.list.tail;
    while (node && removed < need) {
      const prev = node.prev;
      if (toStr(node.v) === targetStr) { l.list.remove(node); removed++; }
      node = prev;
    }
  }
  if (l.list.length === 0) db.del(key);
  return ctx.int(removed);
}

function cmdLTrim(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const l = getList(server, key);
  if (!l) return ctx.ok();
  const len = l.list.length;
  let s = normIndex(parseIntArg(argv[2]), len);
  let e = normIndex(parseIntArg(argv[3]), len);
  if (s < 0) s = 0;
  if (s >= len || s > e) { db.del(key); return ctx.ok(); }
  if (e >= len) e = len - 1;
  let node = l.list.head;
  for (let i = 0; i < s && node; i++) {
    const next = node.next;
    l.list.remove(node);
    node = next;
  }
  const keep = e - s + 1;
  node = l.list.tail;
  while (l.list.length > keep && node) {
    const prev = node.prev;
    l.list.remove(node);
    node = prev;
  }
  if (l.list.length === 0) db.del(key);
  return ctx.ok();
}

function cmdLMove(server, argv, ctx) {
  const db = server.db;
  const src = toStr(argv[1]);
  const dst = toStr(argv[2]);
  const from = toStr(argv[3]).toUpperCase();
  const to = toStr(argv[4]).toUpperCase();
  if ((from !== 'LEFT' && from !== 'RIGHT') || (to !== 'LEFT' && to !== 'RIGHT')) {
    throw err('syntax error');
  }
  const sl = getList(server, src);
  if (!sl) return ctx.nil();
  const value = from === 'LEFT' ? sl.list.popLeft() : sl.list.popRight();
  if (sl.list.length === 0) db.del(src);
  let dl = getList(server, dst);
  if (!dl) { dl = new ListVal(); db.set(dst, dl); }
  if (to === 'LEFT') dl.list.pushLeft(value); else dl.list.pushRight(value);
  return ctx.bulk(value);
}

module.exports = {
  cmdLPush, cmdRPush, cmdLPushX, cmdRPushX, cmdLPop, cmdRPop, cmdLPopCount, cmdRPopCount,
  cmdLLen, cmdLRange, cmdLIndex, cmdLSet, cmdLInsert, cmdLRem, cmdLTrim, cmdLMove,
};
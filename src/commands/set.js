'use strict';

// Set commands: SADD/SREM/SISMEMBER/SMEMBERS/SCARD, SPOP/SRANDMEMBER,
// SMOVE, SINTER/SUNION/SDIFF + STORE variants.

const { toStr, parseIntArg, err, wrongType } = require('../util');
const P = require('../protocol');
const { SetVal } = require('../store/objects');

function getSet(server, key) {
  const obj = server.db.lookup(key);
  if (!obj) return null;
  if (obj.type !== 'set') throw wrongType();
  return obj;
}

function cmdSAdd(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  let s = getSet(server, key);
  if (!s) { s = new SetVal(); db.set(key, s); }
  let added = 0;
  for (let i = 2; i < argv.length; i++) {
    if (s.add(toStr(argv[i]))) added++;
  }
  return ctx.int(added);
}

function cmdSRem(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const s = getSet(server, key);
  if (!s) return ctx.int(0);
  let n = 0;
  for (let i = 2; i < argv.length; i++) {
    if (s.remove(toStr(argv[i]))) n++;
  }
  if (s.length === 0) db.del(key);
  return ctx.int(n);
}

function cmdSIsMember(server, argv, ctx) {
  const s = getSet(server, toStr(argv[1]));
  return ctx.int(s && s.has(toStr(argv[2])) ? 1 : 0);
}

function cmdSMIsMember(server, argv, ctx) {
  const s = getSet(server, toStr(argv[1]));
  const parts = [];
  for (let i = 2; i < argv.length; i++) {
    parts.push(P.encInt(s && s.has(toStr(argv[i])) ? 1 : 0));
  }
  return ctx.arr(parts);
}

function cmdSCard(server, argv, ctx) {
  const s = getSet(server, toStr(argv[1]));
  return ctx.int(s ? s.length : 0);
}

function cmdSMembers(server, argv, ctx) {
  const s = getSet(server, toStr(argv[1]));
  if (!s) return ctx.arr([]);
  return ctx.arr(s.members().map((m) => P.encBulk(Buffer.from(m, 'latin1'))));
}

function cmdSPop(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const s = getSet(server, key);
  if (!s) { ctx.noPropagate = true; return argv.length > 2 ? ctx.nilArr() : ctx.nil(); }
  const count = argv.length > 2 ? parseIntArg(argv[2]) : 1;
  if (count < 0) throw err('value is out of range, must be positive');
  const out = [];
  for (let i = 0; i < count && s.length > 0; i++) {
    const m = s.popRandom(Math.random);
    if (m !== undefined) out.push(m);
  }
  if (out.length === 0) { ctx.noPropagate = true; return argv.length > 2 ? ctx.arr([]) : ctx.bulk(null); }
  if (s.length === 0) db.del(key);
  // SPOP picks randomly, so replaying `SPOP` on a replica/AOF would pop
  // different members. Propagate the actual effect deterministically.
  ctx.effectArgv = [['SREM', key].concat(out)];
  if (argv.length > 2) return ctx.arr(out.map((m) => P.encBulk(Buffer.from(m, 'latin1'))));
  return ctx.bulk(Buffer.from(out[0], 'latin1'));
}

function cmdSRandMember(server, argv, ctx) {
  const s = getSet(server, toStr(argv[1]));
  if (!s) return argv.length > 2 ? ctx.arr([]) : ctx.nil();
  if (argv.length < 3) {
    const m = s.pickRandom(Math.random);
    return ctx.bulk(m === undefined ? null : Buffer.from(m, 'latin1'));
  }
  const count = parseIntArg(argv[2]);
  const members = s.members();
  if (count >= 0) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const m = members[Math.floor(Math.random() * members.length)];
      out.push(P.encBulk(Buffer.from(m, 'latin1')));
    }
    return ctx.arr(out);
  }
  // Negative: distinct elements, up to |count|.
  const n = Math.min(-count, members.length);
  const copy = members.slice();
  // partial Fisher-Yates
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    const t = copy[i]; copy[i] = copy[j]; copy[j] = t;
  }
  return ctx.arr(copy.slice(0, n).map((m) => P.encBulk(Buffer.from(m, 'latin1'))));
}

function cmdSMove(server, argv, ctx) {
  const db = server.db;
  const src = toStr(argv[1]);
  const dst = toStr(argv[2]);
  const member = toStr(argv[3]);
  const ss = getSet(server, src);
  if (!ss || !ss.has(member)) return ctx.int(0);
  ss.remove(member);
  if (ss.length === 0) db.del(src);
  let ds = getSet(server, dst);
  if (!ds) { ds = new SetVal(); db.set(dst, ds); }
  ds.add(member);
  return ctx.int(1);
}

function collectSets(server, argv, fromIdx) {
  const sets = [];
  for (let i = fromIdx; i < argv.length; i++) {
    const s = getSet(server, toStr(argv[i]));
    if (s) sets.push(s);
  }
  return sets;
}

function toSet(value) {
  const s = new SetVal();
  s.add(value);
  return s;
}

function cmdSInter(server, argv, ctx) {
  const sets = collectSets(server, argv, 1);
  if (sets.length === 0) return ctx.arr([]);
  const base = sets.reduce((a, b) => (a.length <= b.length ? a : b));
  const out = [];
  for (const m of base.members()) {
    if (sets.every((s) => s.has(m))) out.push(m);
  }
  return ctx.arr(out.map((m) => P.encBulk(Buffer.from(m, 'latin1'))));
}

function cmdSUnion(server, argv, ctx) {
  const sets = collectSets(server, argv, 1);
  const seen = new SetVal();
  for (const s of sets) for (const m of s.members()) seen.add(m);
  return ctx.arr(seen.members().map((m) => P.encBulk(Buffer.from(m, 'latin1'))));
}

function cmdSDiff(server, argv, ctx) {
  const sets = collectSets(server, argv, 1);
  if (sets.length === 0) return ctx.arr([]);
  const first = sets[0];
  const out = [];
  for (const m of first.members()) {
    let inOther = false;
    for (let i = 1; i < sets.length; i++) {
      if (sets[i].has(m)) { inOther = true; break; }
    }
    if (!inOther) out.push(m);
  }
  return ctx.arr(out.map((m) => P.encBulk(Buffer.from(m, 'latin1'))));
}

function storeResult(server, argv, ctx, op) {
  const db = server.db;
  const dst = toStr(argv[1]);
  const sets = collectSets(server, argv, 2);
  if (op === 'inter') {
    const target = new SetVal();
    if (sets.length > 0) {
      const base = sets.reduce((a, b) => (a.length <= b.length ? a : b));
      for (const m of base.members()) {
        if (sets.every((s) => s.has(m))) target.add(m);
      }
    }
    if (target.length === 0) { db.del(dst); return ctx.int(0); }
    db.set(dst, target);
    return ctx.int(target.length);
  }
  const target = new SetVal();
  for (const s of sets) for (const m of s.members()) target.add(m);
  if (op === 'diff' && sets.length > 0) {
    // SDIFFSTORE semantics: first set minus the others.
    const first = sets[0];
    const remove = new SetVal();
    for (let i = 1; i < sets.length; i++) for (const m of sets[i].members()) remove.add(m);
    const onlyFirst = [];
    for (const m of first.members()) if (!remove.has(m)) onlyFirst.push(m);
    const t2 = new SetVal();
    for (const m of onlyFirst) t2.add(m);
    if (t2.length === 0) { db.del(dst); return ctx.int(0); }
    db.set(dst, t2);
    return ctx.int(t2.length);
  }
  if (target.length === 0) { db.del(dst); return ctx.int(0); }
  db.set(dst, target);
  return ctx.int(target.length);
}

const cmdSInterStore = (server, argv, ctx) => storeResult(server, argv, ctx, 'inter');
const cmdSUnionStore = (server, argv, ctx) => storeResult(server, argv, ctx, 'union');
const cmdSDiffStore = (server, argv, ctx) => storeResult(server, argv, ctx, 'diff');

module.exports = {
  getSet, toSet,
  cmdSAdd, cmdSRem, cmdSIsMember, cmdSMIsMember, cmdSCard, cmdSMembers,
  cmdSPop, cmdSRandMember, cmdSMove, collectSets,
  cmdSInter, cmdSUnion, cmdSDiff, cmdSInterStore, cmdSUnionStore, cmdSDiffStore,
};
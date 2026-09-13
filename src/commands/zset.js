'use strict';

// Sorted-set commands: ZADD, ZSCORE, ZREM, ZCARD, ZRANGE family, ZRANK,
// ZCOUNT, ZINCRBY, ZPOPMIN/POPMAX, ZREMRANGE*, ZLEXCOUNT, ZMSCORE, ZRANDMEMBER.

const {
  toStr, parseIntArg, parseFloatArg, formatDouble, computeRange,
  err, wrongType,
} = require('../util');
const P = require('../protocol');
const { ZSetVal } = require('../store/objects');

function getZset(server, key) {
  const obj = server.db.lookup(key);
  if (!obj) return null;
  if (obj.type !== 'zset') throw wrongType();
  return obj;
}

/* ----------------------------- ZADD ----------------------------- */

function cmdZAdd(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  let nx = false, xx = false, gt = false, lt = false, ch = false, incr = false;
  let i = 2;
  while (i < argv.length && /^[a-zA-Z]+$/.test(toStr(argv[i]))) {
    const o = toStr(argv[i]).toUpperCase();
    if (o === 'NX') nx = true;
    else if (o === 'XX') xx = true;
    else if (o === 'GT') gt = true;
    else if (o === 'LT') lt = true;
    else if (o === 'CH') ch = true;
    else if (o === 'INCR') incr = true;
    else break;
    i++;
  }
  if ((nx && xx) || (gt && lt) || (gt && nx) || (lt && nx)) {
    throw err('GT, LT, NX, XX options are incompatible');
  }
  if ((argv.length - i) % 2 !== 0) throw err('syntax error');
  if (incr && argv.length - i !== 2) throw err('INCR option supports a single increment-element pair');

  let z = getZset(server, key);
  let created = false;
  if (!z) {
    if (xx) return ctx.bulk(null);
    z = new ZSetVal();
    db.set(key, z);
    created = true;
  }
  if (incr) {
    return zAddIncr(server, z, argv, i, { nx, xx, gt, lt }, ctx);
  }
  let added = 0, changed = 0;
  for (let j = i; j < argv.length; j += 2) {
    const score = parseFloatArg(argv[j]);
    const member = toStr(argv[j + 1]);
    const cur = z.getScore(member);
    if (cur === null) {
      if (xx || gt || lt) continue;
      z.add(member, score);
      added++;
    } else {
      if (nx) continue;
      if (gt && score <= cur) continue;
      if (lt && score >= cur) continue;
      z.add(member, score);
      changed++;
    }
  }
  if (z.length === 0 && created) db.del(key);
  return ctx.int(ch ? added + changed : added);
}

function zAddIncr(server, z, argv, i, opts, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const member = toStr(argv[i + 1]);
  const delta = parseFloatArg(argv[i]);
  const cur = z.getScore(member);
  let next;
  if (cur === null) {
    if (opts.xx) return ctx.bulk(null);
    if (opts.gt || opts.lt) return ctx.bulk(null);
    next = delta;
  } else {
    if (opts.nx) return ctx.bulk(null);
    next = cur + delta;
    if (opts.gt && next <= cur) return ctx.bulk(null);
    if (opts.lt && next >= cur) return ctx.bulk(null);
  }
  if (Number.isNaN(next)) throw err('resulting score is not a number (NaN)');
  z.add(member, next);
  return ctx.bulk(Buffer.from(formatDouble(next), 'latin1'));
}

/* ----------------------------- basic reads ----------------------------- */

function cmdZScore(server, argv, ctx) {
  const z = getZset(server, toStr(argv[1]));
  if (!z) return ctx.nil();
  const s = z.getScore(toStr(argv[2]));
  return ctx.bulk(s === null ? null : Buffer.from(formatDouble(s), 'latin1'));
}

function cmdZMScore(server, argv, ctx) {
  const z = getZset(server, toStr(argv[1]));
  const parts = [];
  if (z) {
    for (let i = 2; i < argv.length; i++) {
      const s = z.getScore(toStr(argv[i]));
      parts.push(s === null ? P.encNull() : P.encBulk(Buffer.from(formatDouble(s), 'latin1')));
    }
  } else {
    for (let i = 2; i < argv.length; i++) parts.push(P.encNull());
  }
  return ctx.arr(parts);
}

function cmdZRem(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const z = getZset(server, key);
  if (!z) return ctx.int(0);
  let n = 0;
  for (let i = 2; i < argv.length; i++) {
    if (z.remove(toStr(argv[i]))) n++;
  }
  if (z.length === 0) db.del(key);
  return ctx.int(n);
}

function cmdZCard(server, argv, ctx) {
  const z = getZset(server, toStr(argv[1]));
  return ctx.int(z ? z.length : 0);
}

function cmdZIncrBy(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const incr = parseFloatArg(argv[2]);
  const member = toStr(argv[3]);
  let z = getZset(server, key);
  if (!z) { z = new ZSetVal(); db.set(key, z); }
  const cur = z.getScore(member);
  const next = (cur === null ? 0 : cur) + incr;
  if (Number.isNaN(next)) throw err('resulting score is not a number (NaN)');
  z.add(member, next);
  return ctx.bulk(Buffer.from(formatDouble(next), 'latin1'));
}

function cmdZRemRangeByRank(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const z = getZset(server, key);
  if (!z) return ctx.int(0);
  const len = z.length;
  let s = parseIntArg(argv[2]);
  let e = parseIntArg(argv[3]);
  if (s < 0) s = len + s;
  if (e < 0) e = len + e;
  if (s < 0) s = 0;
  if (e >= len) e = len - 1;
  if (s > e || s >= len || e < 0) return ctx.int(0);
  const all = z.sl.toArray();
  let n = 0;
  for (let i = s; i <= e; i++) {
    if (z.remove(all[i].member)) n++;
  }
  if (z.length === 0) db.del(key);
  return ctx.int(n);
}

function cmdZPop(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const z = getZset(server, key);
  if (!z) return ctx.nilArr();
  const count = argv.length > 2 ? Math.max(0, parseIntArg(argv[2])) : 1;
  const min = toStr(argv[0]).toUpperCase().startsWith('ZPOPMIN');
  const parts = [];
  for (let i = 0; i < count && z.length > 0; i++) {
    const node = min ? z.sl.head[0] : z.sl.tail;
    if (!node) break;
    parts.push(P.encBulk(Buffer.from(node.member, 'latin1')), P.encBulk(Buffer.from(formatDouble(node.score), 'latin1')));
    z.remove(node.member);
  }
  if (z.length === 0) db.del(key);
  return ctx.arr(parts);
}

function cmdZCount(server, argv, ctx) {
  const z = getZset(server, toStr(argv[1]));
  if (!z) return ctx.int(0);
  const min = parseScoreBound(argv[2]);
  const max = parseScoreBound(argv[3]);
  let n = 0;
  for (const { score } of z.sl.toArray()) {
    const loOk = min.exclusive ? score > min.value : score >= min.value;
    const hiOk = max.exclusive ? score < max.value : score <= max.value;
    if (loOk && hiOk) n++;
  }
  return ctx.int(n);
}

function zRangeByLex(z, minBuf, maxBuf, rev) {
  let min = parseLexBound(minBuf);
  let max = parseLexBound(maxBuf);
  if (rev) { const t = min; min = max; max = t; }
  const members = z.sl.toArray().map((x) => x.member);
  return members.filter((m) => {
    const loOk = min.dir === -1 ? true
      : min.exclusive ? m > min.value : m >= min.value;
    const hiOk = max.dir === 1 ? true
      : max.exclusive ? m < max.value : m <= max.value;
    return loOk && hiOk;
  });
}

function zRangeByIndex(z, startBuf, stopBuf, rev) {
  const len = z.length;
  if (len === 0) return [];
  let s = parseIntArg(startBuf);
  let e = parseIntArg(stopBuf);
  if (s < 0) s = len + s;
  if (e < 0) e = len + e;
  if (s < 0) s = 0;
  if (e >= len) e = len - 1;
  if (s > e || s >= len || e < 0) return [];
  const arr = z.sl.toArray();
  if (rev) {
    const from = len - 1 - e;
    const to = len - 1 - s;
    return arr.slice(from, to + 1).reverse();
  }
  return arr.slice(s, e + 1);
}

function zRangeByScore(z, minBuf, maxBuf, rev) {
  let min = parseScoreBound(minBuf);
  let max = parseScoreBound(maxBuf);
  if (rev) { const t = min; min = max; max = t; }
  const items = z.sl.toArray();
  const filter = (it) => {
    const loOk = min.exclusive ? it.score > min.value : it.score >= min.value;
    const hiOk = max.exclusive ? it.score < max.value : it.score <= max.value;
    return loOk && hiOk;
  };
  const out = items.filter(filter);
  return rev ? out.reverse() : out;
}

function emitZRange(z, items, withScores, ctx, P2) {
  if (!withScores) {
    return ctx.arr(items.map((it) => P2.encBulk(Buffer.from(it.member, 'latin1'))));
  }
  const parts = [];
  for (const it of items) {
    parts.push(P2.encBulk(Buffer.from(it.member, 'latin1')), P2.encBulk(Buffer.from(formatDouble(it.score), 'latin1')));
  }
  return ctx.arr(parts);
}

function cmdZRange(server, argv, ctx) {
  const z = getZset(server, toStr(argv[1]));
  const P2 = P;
  if (!z) return ctx.arr([]);
  let rev = false, withScores = false, byScore = false, byLex = false;
  for (let i = 4; i < argv.length; i++) {
    const o = toStr(argv[i]).toUpperCase();
    if (o === 'REV') rev = true;
    else if (o === 'WITHSCORES') withScores = true;
    else if (o === 'BYSCORE') byScore = true;
    else if (o === 'BYLEX') byLex = true;
    else if (o === 'LIMIT') i += 2;
    else throw err('syntax error');
  }
  if (byScore) {
    const items = zRangeByScore(z, argv[2], argv[3], rev);
    return emitZRange(z, items, withScores, ctx, P2);
  }
  if (byLex) {
    const items = zRangeByLex(z, argv[2], argv[3], rev);
    if (withScores) {
      const parts = [];
      for (const m of items) {
        parts.push(P2.encBulk(Buffer.from(m, 'latin1')), P2.encBulk(Buffer.from(formatDouble(z.getScore(m)), 'latin1')));
      }
      return ctx.arr(parts);
    }
    return ctx.arr(items.map((m) => P2.encBulk(Buffer.from(m, 'latin1'))));
  }
  const items = zRangeByIndex(z, argv[2], argv[3], rev);
  return emitZRange(z, items, withScores, ctx, P2);
}

function cmdZRevRange(server, argv, ctx) {
  const newArgv = [argv[0], argv[1], argv[2], argv[3]];
  for (let i = 4; i < argv.length; i++) newArgv.push(argv[i]);
  newArgv.push(Buffer.from('REV', 'latin1'));
  return cmdZRange(server, newArgv, ctx);
}

function cmdZRevRangeByScore(server, argv, ctx) {
  const newArgv = [argv[0], argv[1], argv[3], argv[2]];
  for (let i = 4; i < argv.length; i++) newArgv.push(argv[i]);
  newArgv.push(Buffer.from('REV', 'latin1'), Buffer.from('BYSCORE', 'latin1'));
  return cmdZRange(server, newArgv, ctx);
}

function cmdZRangeByScore(server, argv, ctx) {
  const newArgv = [argv[0], argv[1], argv[2], argv[3]];
  for (let i = 4; i < argv.length; i++) newArgv.push(argv[i]);
  newArgv.push(Buffer.from('BYSCORE', 'latin1'));
  return cmdZRange(server, newArgv, ctx);
}

function cmdZRangeByLex(server, argv, ctx) {
  const newArgv = [argv[0], argv[1], argv[2], argv[3]];
  for (let i = 4; i < argv.length; i++) newArgv.push(argv[i]);
  newArgv.push(Buffer.from('BYLEX', 'latin1'));
  return cmdZRange(server, newArgv, ctx);
}

function cmdZRevRangeByLex(server, argv, ctx) {
  const newArgv = [argv[0], argv[1], argv[3], argv[2]];
  for (let i = 4; i < argv.length; i++) newArgv.push(argv[i]);
  newArgv.push(Buffer.from('REV', 'latin1'), Buffer.from('BYLEX', 'latin1'));
  return cmdZRange(server, newArgv, ctx);
}

function cmdZRank(server, argv, ctx) {
  const z = getZset(server, toStr(argv[1]));
  const member = toStr(argv[2]);
  if (!z || !z.has(member)) return ctx.bulk(null);
  const all = z.sl.toArray();
  const r = all.findIndex((it) => it.member === member);
  return ctx.int(r);
}

function cmdZRevRank(server, argv, ctx) {
  const z = getZset(server, toStr(argv[1]));
  const member = toStr(argv[2]);
  if (!z || !z.has(member)) return ctx.bulk(null);
  const all = z.sl.toArray();
  const r = all.findIndex((it) => it.member === member);
  return ctx.int(all.length - 1 - r);
}

function cmdZRemRangeByScore(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const z = getZset(server, key);
  if (!z) return ctx.int(0);
  const min = parseScoreBound(argv[2]);
  const max = parseScoreBound(argv[3]);
  const toRemove = z.sl.toArray().filter((it) => {
    const loOk = min.exclusive ? it.score > min.value : it.score >= min.value;
    const hiOk = max.exclusive ? it.score < max.value : it.score <= max.value;
    return loOk && hiOk;
  });
  let n = 0;
  for (const it of toRemove) if (z.remove(it.member)) n++;
  if (z.length === 0) db.del(key);
  return ctx.int(n);
}

function cmdZLexCount(server, argv, ctx) {
  const z = getZset(server, toStr(argv[1]));
  if (!z) return ctx.int(0);
  try {
    const items = zRangeByLex(z, argv[2], argv[3], false);
    return ctx.int(items.length);
  } catch (e) {
    if (e.xrCommand) throw e;
    throw err('min or max not valid string range item');
  }
}

function cmdZRemRangeByLex(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const z = getZset(server, key);
  if (!z) return ctx.int(0);
  const toRemove = zRangeByLex(z, argv[2], argv[3], false);
  let n = 0;
  for (const m of toRemove) {
    if (z.remove(m)) n++;
  }
  if (z.length === 0) db.del(key);
  return ctx.int(n);
}

function cmdZInterStore(server, argv, ctx) {
  return zStoreCombine(server, argv, ctx, 'inter');
}

function cmdZUnionStore(server, argv, ctx) {
  return zStoreCombine(server, argv, ctx, 'union');
}

// Shared implementation for ZINTERSTORE / ZUNIONSTORE with WEIGHTS and
// AGGREGATE (SUM/MIN/MAX). Source keys may be zsets (natural scores) or sets
// (implicit score 1), matching Redis semantics.
function zStoreCombine(server, argv, ctx, mode) {
  const db = server.db;
  const dst = toStr(argv[1]);
  const numkeys = parseIntArg(argv[2]);
  if (numkeys < 0) throw err('value is not an integer or out of range');
  if (argv.length < 3 + numkeys) throw err('syntax error');

  const srcKeys = [];
  for (let i = 0; i < numkeys; i++) srcKeys.push(toStr(argv[3 + i]));

  // Parse optional WEIGHTS / AGGREGATE.
  let weights = srcKeys.map(() => 1);
  let aggregate = 'sum';
  for (let i = 3 + numkeys; i < argv.length; i++) {
    const o = toStr(argv[i]).toUpperCase();
    if (o === 'WEIGHTS') {
      const cnt = numkeys;
      if (i + cnt >= argv.length) throw err('syntax error');
      for (let w = 0; w < cnt; w++) {
        weights[w] = parseFloatArg(argv[i + 1 + w]);
      }
      i += cnt;
    } else if (o === 'AGGREGATE') {
      if (i + 1 >= argv.length) throw err('syntax error');
      aggregate = toStr(argv[i + 1]).toUpperCase();
      if (!['SUM', 'MIN', 'MAX'].includes(aggregate)) throw err('syntax error');
      i++;
    } else {
      throw err('syntax error');
    }
  }

  const acc = new Map(); // member -> { score, count }
  for (let s = 0; s < srcKeys.length; s++) {
    const key = srcKeys[s];
    // NOTE: dst may itself be a source; Redis reads sources before writing dst,
    // and we only db.set(dst) at the very end, so no special-casing needed.
    const obj = db.lookup(key);
    if (!obj) continue; // missing source: empty set
    let entries;
    if (obj.type === 'zset') {
      entries = obj.sl.toArray().map((it) => ({ member: it.member, score: it.score }));
    } else if (obj.type === 'set') {
      entries = obj.members().map((m) => ({ member: m, score: 1 }));
    } else {
      throw wrongType();
    }
    const w = weights[s];
    for (const { member, score } of entries) {
      const val = score * w;
      const cur = acc.get(member);
      if (!cur) {
        acc.set(member, { score: val, count: 1 });
      } else {
        cur.count++;
        cur.score = combineScores(aggregate, cur.score, val);
      }
    }
  }

  // For INTERSECTION only members present in every source survive.
  const result = [];
  for (const [member, { score, count }] of acc) {
    if (mode === 'inter') {
      // Count non-missing sources; missing sources make the intersection empty
      // only if the member never appeared — handled by count vs numkeys below.
      if (count === numkeys) result.push({ member, score });
    } else {
      result.push({ member, score });
    }
  }

  if (dstKeyHadValue(db, dst)) db.del(dst);
  if (result.length === 0) return ctx.int(0);
  const z = new ZSetVal();
  for (const { member, score } of result) z.add(member, score);
  db.set(dst, z);
  return ctx.int(z.length);
}

function dstKeyHadValue(db, dst) {
  return db.lookup(dst) !== null;
}

function combineScores(aggregate, a, b) {
  if (aggregate === 'MIN') return Math.min(a, b);
  if (aggregate === 'MAX') return Math.max(a, b);
  return a + b;
}

module.exports = {
  cmdZAdd, cmdZScore, cmdZMScore, cmdZRem, cmdZCard, cmdZIncrBy,
  cmdZRemRangeByRank, cmdZPop, cmdZCount, zRangeByLex, zRangeByIndex,
  cmdZRange, cmdZRevRange, cmdZRangeByScore, cmdZRevRangeByScore,
  cmdZRangeByLex, cmdZRevRangeByLex, cmdZRank, cmdZRevRank, cmdZRemRangeByScore,
  cmdZLexCount, cmdZRemRangeByLex, cmdZInterStore, cmdZUnionStore,
  getZset,
};
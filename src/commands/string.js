'use strict';

// String commands: SET/GET family, INCR family, ranges, bits, MGET/MSET.

const {
  toStr, parseIntArg, parseFloatArg, formatDouble, err, wrongType,
} = require('../util');
const { StrVal } = require('../store/objects');

function cmdSet(server, argv, ctx) {
  const key = toStr(argv[1]);
  let nx = false, xx = false, get = false, keepTtl = false, seenExpire = false;
  let relTtl = 0, absTtl = null;
  for (let i = 3; i < argv.length; i++) {
    const opt = toStr(argv[i]).toUpperCase();
    switch (opt) {
      case 'NX': if (xx) throw err('syntax error'); nx = true; break;
      case 'XX': if (nx) throw err('syntax error'); xx = true; break;
      case 'GET': get = true; break;
      case 'KEEPTTL': if (seenExpire) throw err('syntax error'); keepTtl = true; break;
      case 'EX': case 'PX': {
        if (seenExpire) throw err('syntax error');
        if (i + 1 >= argv.length) throw err('syntax error');
        const v = parseIntArg(argv[++i]);
        if (v < 0) throw err('invalid expire time in \'set\' command');
        relTtl = opt === 'EX' ? v * 1000 : v;
        seenExpire = true;
        break;
      }
      case 'EXAT': case 'PXAT': {
        if (seenExpire) throw err('syntax error');
        if (i + 1 >= argv.length) throw err('syntax error');
        const v = parseIntArg(argv[++i]);
        if (v < 0) throw err('invalid expire time in \'set\' command');
        absTtl = opt === 'EXAT' ? v * 1000 : v;
        seenExpire = true;
        break;
      }
      default: throw err('syntax error');
    }
  }
  const db = server.db;
  const now = Date.now();
  const old = db.lookup(key, now);
  if (old && old.type !== 'string') throw wrongType();
  if (nx && old) { ctx.noPropagate = true; return get ? ctx.bulk(old.buf) : ctx.nil(); }
  if (xx && !old) { ctx.noPropagate = true; return get ? ctx.bulk(null) : ctx.nil(); }
  const obj = new StrVal(argv[2]);
  db.set(key, obj);
  if (seenExpire && !keepTtl) {
    if (absTtl !== null) db.expires.set(key, absTtl);
    else db.expires.set(key, now + relTtl);
  } else if (!keepTtl) {
    db.expires.delete(key);
  }
  const ex = db.expires.get(key);
  if (ex !== undefined && ex <= Date.now()) {
    // Expired on write: the key is gone. Propagate a DEL so AOF/replicas do
    // not resurrect it (a bare SET would).
    db.del(key);
    ctx.effectArgv = [['DEL', key]];
  }
  return get ? ctx.bulk(old ? old.buf : null) : ctx.ok();
}

function cmdGet(server, argv, ctx) {
  const obj = server.db.lookup(toStr(argv[1]));
  if (!obj) return ctx.nil();
  if (obj.type !== 'string') throw wrongType();
  return ctx.bulk(obj.buf);
}

function cmdSetNX(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  if (db.lookup(key) !== null) return ctx.int(0);
  db.set(key, new StrVal(argv[2]));
  return ctx.int(1);
}

function cmdSetEX(server, argv, ctx) { return setEX(server, argv, ctx, 1000); }
function cmdPSetEX(server, argv, ctx) { return setEX(server, argv, ctx, 1); }

function setEX(server, argv, ctx, mult) {
  const secs = parseIntArg(argv[2]);
  if (secs <= 0) throw err('invalid expire time in setex command');
  const db = server.db;
  const key = toStr(argv[1]);
  db.set(key, new StrVal(argv[3]));
  db.expires.set(key, Date.now() + secs * mult);
  return ctx.ok();
}

function cmdGetSet(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const old = db.lookup(key);
  if (old && old.type !== 'string') throw wrongType();
  db.set(key, new StrVal(argv[2]));
  db.expires.delete(key);
  return ctx.bulk(old ? old.buf : null);
}

function cmdGetDel(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const obj = db.lookup(key);
  if (!obj) return ctx.nil();
  if (obj.type !== 'string') throw wrongType();
  db.del(key);
  return ctx.bulk(obj.buf);
}

function cmdGetEx(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const now = Date.now();
  const obj = db.lookup(key, now);
  if (!obj) return ctx.nil();
  if (obj.type !== 'string') throw wrongType();
  if (argv.length > 2) {
    const opt = toStr(argv[2]).toUpperCase();
    let mesc = null;
    if (opt === 'PERSIST') { db.expires.delete(key); }
    else if (opt === 'EX' || opt === 'PX' || opt === 'EXAT' || opt === 'PXAT') {
      const v = parseIntArg(argv[3]);
      if (v < 0) throw err('invalid expire time in \'getex\' command');
      mesc = (opt === 'EX' || opt === 'EXAT')
        ? (opt === 'EX' ? now + v * 1000 : v * 1000)
        : (opt === 'PXAT' ? v : now + v);
    } else throw err('syntax error');
    if (mesc !== null) db.expires.set(key, mesc);
  }
  return ctx.bulk(obj.buf);
}

/* --------------------------- append / strlen --------------------------- */

function cmdAppend(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const obj = db.lookup(key);
  if (obj && obj.type !== 'string') throw wrongType();
  if (!obj) {
    const fresh = new StrVal(argv[2]);
    db.set(key, fresh);
    return ctx.int(fresh.buf.length);
  }
  obj.buf = Buffer.concat([obj.buf, argv[2]]);
  obj._int = null;
  return ctx.int(obj.buf.length);
}

function cmdStrlen(server, argv, ctx) {
  const obj = server.db.lookup(toStr(argv[1]));
  return ctx.int(obj && obj.type === 'string' ? obj.buf.length : 0);
}

/* ---------------------------- INCR / DECR ---------------------------- */

function cmdIncr(server, argv, ctx) { return incr(server, argv, ctx, 1); }
function cmdDecr(server, argv, ctx) { return incr(server, argv, ctx, -1); }
function cmdIncrBy(server, argv, ctx) { return incr(server, argv, ctx, parseIntArg(argv[2])); }
function cmdDecrBy(server, argv, ctx) { return incr(server, argv, ctx, -parseIntArg(argv[2])); }

function incr(server, argv, ctx, delta) {
  const db = server.db;
  const key = toStr(argv[1]);
  const obj = db.lookup(key);
  if (obj && obj.type !== 'string') throw wrongType();
  let cur = obj ? obj.int : 0;
  if (cur === null) throw err('value is not an integer or out of range');
  const next = cur + delta;
  if (!Number.isSafeInteger(next)) throw err('increment or decrement would overflow');
  const buf = Buffer.from(String(next), 'latin1');
  if (obj) { obj.buf = buf; obj._int = next; }
  else db.set(key, new StrVal(buf, { int: next }));
  return ctx.int(next);
}

function cmdIncrByFloat(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const incr = parseFloatArg(argv[2]);
  const obj = db.lookup(key);
  if (obj && obj.type !== 'string') throw wrongType();
  let cur = 0;
  if (obj && obj.buf.length > 0) {
    if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(obj.buf.toString('latin1'))) {
      throw err('value is not a valid float');
    }
    cur = Number(obj.buf.toString('latin1'));
  }
  const res = formatDouble(cur + incr);
  if (res === 'NaN' || res === 'Infinity' || res === '-Infinity') {
    throw err('increment would produce NaN or Infinity');
  }
  const buf = Buffer.from(res, 'latin1');
  if (obj) { obj.buf = buf; obj._int = null; }
  else db.set(key, new StrVal(buf));
  return ctx.bulk(buf);
}

/* ---------------------- MGET / MSET / MSETNX ---------------------- */

function cmdMGet(server, argv, ctx) {
  const db = server.db;
  const P = require('../protocol');
  const parts = [];
  for (let i = 1; i < argv.length; i++) {
    const obj = db.lookup(toStr(argv[i]));
    parts.push((obj && obj.type === 'string') ? P.encBulk(obj.buf) : P.encNull());
  }
  return ctx.arr(parts);
}

function cmdMSet(server, argv, ctx) {
  if ((argv.length - 1) % 2 !== 0) throw err('wrong number of arguments for MSET');
  const db = server.db;
  const now = Date.now();
  for (let i = 1; i < argv.length; i += 2) {
    const key = toStr(argv[i]);
    const old = db.lookup(key, now);
    if (old && old.type !== 'string') throw wrongType();
    db.set(key, new StrVal(argv[i + 1]));
    db.expires.delete(key);
  }
  return ctx.ok();
}

function cmdMSetNX(server, argv, ctx) {
  if ((argv.length - 1) % 2 !== 0) throw err('wrong number of arguments for MSETNX');
  const db = server.db;
  for (let i = 1; i < argv.length; i += 2) {
    if (db.lookup(toStr(argv[i])) !== null) return ctx.int(0);
  }
  for (let i = 1; i < argv.length; i += 2) {
    db.set(toStr(argv[i]), new StrVal(argv[i + 1]));
  }
  return ctx.int(1);
}

/* ------------------------ GETRANGE / SETRANGE ------------------------ */

function cmdGetRange(server, argv, ctx) {
  const db = server.db;
  const obj = db.lookup(toStr(argv[1]));
  if (!obj) return ctx.bulk(Buffer.alloc(0));
  if (obj.type !== 'string') throw wrongType();
  const len = obj.buf.length;
  let start = parseIntArg(argv[2]);
  let end = parseIntArg(argv[3]);
  if (start < 0) start = len + start;
  if (end < 0) end = len + end;
  if (start < 0) start = 0;
  if (start > end || start >= len) return ctx.bulk(Buffer.alloc(0));
  if (end >= len) end = len - 1;
  return ctx.bulk(obj.buf.subarray(start, end + 1));
}

function cmdSetRange(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const offset = parseIntArg(argv[2]);
  if (offset < 0) throw err('offset is out of range');
  const obj = db.lookup(key);
  if (obj && obj.type !== 'string') throw wrongType();
  const value = argv[3];
  const required = offset + value.length;
  let buf;
  if (!obj) buf = Buffer.alloc(required);
  else if (obj.buf.length >= required) buf = obj.buf;
  else {
    buf = Buffer.alloc(required);
    obj.buf.copy(buf, 0);
  }
  value.copy(buf, offset);
  if (obj) { obj.buf = buf; obj._int = null; }
  else db.set(key, new StrVal(buf));
  return ctx.int(buf.length);
}

/* ---------------------------- BIT commands ---------------------------- */

function cmdSetBit(server, argv, ctx) {
  const db = server.db;
  const key = toStr(argv[1]);
  const offset = parseIntArg(argv[2]);
  const bit = parseIntArg(argv[3]);
  if (offset < 0) throw err('bit offset is not an integer or out of range');
  if (bit !== 0 && bit !== 1) throw err('bit is not an integer or out of range');
  const obj = db.lookup(key);
  if (obj && obj.type !== 'string') throw wrongType();
  let buf = obj ? obj.buf : Buffer.alloc(0);
  const byteIdx = offset >> 3;
  const bitIdx = 7 - (offset & 7);
  if (byteIdx >= buf.length) {
    const grown = Buffer.alloc(byteIdx + 1);
    buf.copy(grown, 0);
    buf = grown;
  }
  const oldBit = (buf[byteIdx] >> bitIdx) & 1;
  if (bit) buf[byteIdx] |= (1 << bitIdx);
  else buf[byteIdx] &= ~(1 << bitIdx);
  if (obj) { obj.buf = buf; obj._int = null; }
  else db.set(key, new StrVal(buf));
  return ctx.int(oldBit);
}

function cmdGetBit(server, argv, ctx) {
  const db = server.db;
  const obj = db.lookup(toStr(argv[1]));
  if (!obj) return ctx.int(0);
  if (obj.type !== 'string') throw wrongType();
  const offset = parseIntArg(argv[2]);
  if (offset < 0) throw err('bit offset is not an integer or out of range');
  const byteIdx = offset >> 3;
  if (byteIdx >= obj.buf.length) return ctx.int(0);
  return ctx.int((obj.buf[byteIdx] >> (7 - (offset & 7))) & 1);
}

function cmdBitCount(server, argv, ctx) {
  const db = server.db;
  const obj = db.lookup(toStr(argv[1]));
  if (!obj) return ctx.int(0);
  if (obj.type !== 'string') throw wrongType();
  const buf = obj.buf;
  let start = 0, end = buf.length - 1;
  if (argv.length >= 4) {
    start = parseIntArg(argv[2]);
    end = parseIntArg(argv[3]);
    if (start < 0) start = buf.length + start;
    if (end < 0) end = buf.length + end;
    if (start < 0) start = 0;
    if (end >= buf.length) end = buf.length - 1;
  }
  if (start > end || start >= buf.length || end < 0) return ctx.int(0);
  let count = 0;
  for (let i = start; i <= end; i++) count += popcount(buf[i]);
  return ctx.int(count);
}

function popcount(b) {
  b = b - ((b >> 1) & 0x55);
  b = (b & 0x33) + ((b >> 2) & 0x33);
  return (b + (b >> 4)) & 0x0f;
}

function cmdBitPos(server, argv, ctx) {
  const db = server.db;
  const obj = db.lookup(toStr(argv[1]));
  const buf = obj ? obj.buf : Buffer.alloc(0);
  if (obj && obj.type !== 'string') throw wrongType();
  const bit = parseIntArg(argv[2]);
  if (bit !== 0 && bit !== 1) throw err('The bit argument must be 1 or 0.');
  let start = argv.length > 3 ? parseIntArg(argv[3]) : 0;
  let end = argv.length > 4 ? parseIntArg(argv[4]) : buf.length - 1;
  if (start < 0) start = buf.length + start;
  if (end < 0) end = buf.length + end;
  if (start < 0) start = 0;
  if (end >= buf.length) end = buf.length - 1;
  if (start > end || start >= buf.length || end < 0) return ctx.int(-1);
  for (let i = start; i <= end; i++) {
    const byte = buf[i];
    for (let b = 7; b >= 0; b--) {
      if (((byte >> b) & 1) === bit) return ctx.int(i * 8 + (7 - b));
    }
  }
  return ctx.int(-1);
}

module.exports = {
  cmdSet, cmdGet, cmdSetNX, cmdSetEX, cmdPSetEX, cmdGetSet, cmdGetDel, cmdGetEx,
  cmdAppend, cmdStrlen, cmdIncr, cmdDecr, cmdIncrBy, cmdDecrBy, cmdIncrByFloat,
  cmdMGet, cmdMSet, cmdMSetNX, cmdGetRange, cmdSetRange,
  cmdSetBit, cmdGetBit, cmdBitCount, cmdBitPos,
};
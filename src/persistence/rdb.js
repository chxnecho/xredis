'use strict';

// RDB snapshot persistence — a Redis-compatible binary snapshot format.
//
// Layout:
//   "REDIS0011"          magic + version
//   0xFA <str> <str>     aux fields (redis-ver, redis-bits)
//   0xFC <8B LE ms>      expire time (ms) for the next key
//   0xFD <4B LE db>      select db (32-bit variant)
//   0xFB <len> <len>     resizedb hint (keys, expires)
//   <type> <key> <val>   key/value pairs
//   0xFF                 EOF
//   <8B CRC64-ECMA>      checksum over everything before it
//
// String encodings: 11xxxxxx special → 1100 0000 int8 / 1100 0001 int16 /
// 1100 0010 int32. Lengths: 00 6-bit, 01 14-bit, 10 32-bit big endian.
//
// Types: 0 string, 1 list, 2 set, 4 hash, 5 zset_2 (score as 8B LE double),
// 11 set-as-intset-blob.

const fs = require('fs');
const path = require('path');
const { StrVal, ListVal, HashVal, SetVal, ZSetVal } = require('../store/objects');

const RDB_MAGIC = 'REDIS0011';

const OPCODE = {
  AUX: 0xFA,
  RESIZEDB: 0xFB,
  EXPIRETIME_MS: 0xFC,
  SELECTDB32: 0xFD,
  EOF: 0xFF,
};

const TYPE = {
  STRING: 0,
  LIST: 1,
  SET: 2,
  ZSET: 3,
  HASH: 4,
  ZSET_2: 5,
  SET_INTSET: 11,
};

/* ------------------------------ CRC64-ECMA ------------------------------ */

const CRC_TABLE = (() => {
  const table = new BigUint64Array(256);
  const POLY = 0x42f0e1eba9ea3693n;
  for (let i = 0; i < 256; i++) {
    let crc = BigInt(i) << 56n;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000000000000000n) crc = ((crc << 1n) ^ POLY) & 0xffffffffffffffffn;
      else crc <<= 1n;
    }
    table[i] = crc;
  }
  return table;
})();

function crc64(buf) {
  let crc = 0xffffffffffffffffn;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(Number(crc >> 56n) ^ buf[i]) & 0xff] ^ (crc << 8n)) & 0xffffffffffffffffn;
  }
  return crc ^ 0xffffffffffffffffn;
}

/* ------------------------------ writer ------------------------------ */

class Writer {
  constructor() { this.parts = []; }

  byte(b) { this.parts.push(Buffer.from([b & 0xff])); return this; }
  raw(buf) { this.parts.push(buf); return this; }
  cstr(s) { this.parts.push(Buffer.from(s, 'latin1')); return this; }

  u32le(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    this.parts.push(b);
    return this;
  }

  u64le(n) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n), 0);
    this.parts.push(b);
    return this;
  }

  f64le(n) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n, 0);
    this.parts.push(b);
    return this;
  }

  u16le(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    this.parts.push(b);
    return this;
  }

  // RDB length: 00 → 6-bit, 01 → 14-bit, 10 → 32-bit BE.
  len(n) {
    if (n < 1 << 6) {
      this.parts.push(Buffer.from([n & 0x3f]));
    } else if (n < 1 << 14) {
      this.parts.push(Buffer.from([0x40 | ((n >> 8) & 0x3f), n & 0xff]));
    } else {
      const b = Buffer.alloc(5);
      b[0] = 0x80;
      b.writeUInt32BE(n >>> 0, 1);
      this.parts.push(b);
    }
    return this;
  }

  // String value with special integer encodings when profitable.
  str(buf) {
    if (typeof buf === 'string') buf = Buffer.from(buf, 'latin1');
    else if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), 'latin1');
    if (buf.length <= 20) {
      const s = buf.toString('latin1');
      if (/^-?\d+$/.test(s)) {
        const n = Number(s);
        if (Number.isSafeInteger(n)) {
          if (n >= -128 && n <= 127) return this.byte(0xc0).raw(Buffer.from([n & 0xff]));
          if (n >= -32768 && n <= 32767) return this.byte(0xc1).u16le(n < 0 ? n + 0x10000 : n);
          return this.byte(0xc2).u32le(n < 0 ? n + 0x100000000 : n);
        }
      }
    }
    this.len(buf.length);
    this.parts.push(buf);
    return this;
  }

  toBuffer() { return Buffer.concat(this.parts); }
}

module.exports = { Writer, crc64, OPCODE, TYPE, RDB_MAGIC };

/* ------------------------------ serializer ------------------------------ */

// Serialize the whole keyspace to a Buffer.
function serialize(server) {
  const w = new Writer();
  w.cstr(RDB_MAGIC);
  w.byte(OPCODE.AUX); w.str(Buffer.from('redis-ver')); w.str(Buffer.from('7.0.0'));
  w.byte(OPCODE.AUX); w.str(Buffer.from('redis-bits')); w.str(Buffer.from('64'));

  const now = Date.now();
  let totalKeys = 0, totalExpires = 0;
  const dbs = server.keyspace.all().filter((db) => {
    const keys = db.allKeys(now);
    totalKeys += keys.length;
    totalExpires += db.expires.size;
    return keys.length > 0;
  });
  w.byte(OPCODE.RESIZEDB); w.len(totalKeys); w.len(totalExpires);

  for (const db of dbs) {
    w.byte(OPCODE.SELECTDB32); w.u32le(db.id);
    for (const key of db.dict.keys()) {
      const ex = db.expires.get(key);
      if (ex !== undefined && ex <= now) continue;
      const obj = db.lookup(key, now);
      if (!obj) continue;
      if (ex !== undefined) {
        w.byte(OPCODE.EXPIRETIME_MS); w.u64le(ex);
      }
      writeObject(w, key, obj);
    }
  }

  w.byte(OPCODE.EOF);
  const body = w.toBuffer();
  const crc = Buffer.alloc(8);
  crc.writeBigUInt64LE(crc64(body), 0);
  return Buffer.concat([body, crc]);
}

function writeObject(w, key, obj) {
  switch (obj.type) {
    case 'string':
      w.byte(TYPE.STRING); w.str(Buffer.from(key, 'latin1')); w.str(obj.buf);
      break;
    case 'list': {
      const items = obj.list.toArray();
      w.byte(TYPE.LIST); w.str(Buffer.from(key, 'latin1')); w.len(items.length);
      for (const it of items) w.str(it);
      break;
    }
    case 'set': {
      if (!obj.map && obj.is && obj.is.length) {
        // Keep the compact intset encoding.
        w.byte(TYPE.SET_INTSET);
        w.str(Buffer.from(key, 'latin1'));
        w.str(serializeIntSet(obj.is.toArray()));
      } else {
        const members = obj.members();
        w.byte(TYPE.SET); w.str(Buffer.from(key, 'latin1')); w.len(members.length);
        for (const m of members) w.str(Buffer.from(m, 'latin1'));
      }
      break;
    }
    case 'hash': {
      w.byte(TYPE.HASH); w.str(Buffer.from(key, 'latin1')); w.len(obj.map.size);
      for (const [f, v] of obj.map) {
        w.str(Buffer.from(f, 'latin1')); w.str(v);
      }
      break;
    }
    case 'zset': {
      w.byte(TYPE.ZSET_2); w.str(Buffer.from(key, 'latin1')); w.len(obj.length);
      for (const { member, score } of obj.sl.toArray()) {
        w.str(Buffer.from(member, 'latin1')); w.f64le(score);
      }
      break;
    }
    default:
      throw new Error('cannot serialize type: ' + obj.type);
  }
}

// Minimal intset container format: <i32 encoding><i32 length><ints...>.
function serializeIntSet(ints) {
  const maxAbs = ints.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const enc = maxAbs <= 0x7f ? 1 : (maxAbs <= 0x7fff ? 2 : 4);
  const out = Buffer.alloc(8 + ints.length * enc);
  out.writeInt32LE(enc, 0);
  out.writeInt32LE(ints.length, 4);
  for (let i = 0; i < ints.length; i++) {
    if (enc === 1) out.writeInt8(ints[i], 8 + i);
    else if (enc === 2) out.writeInt16LE(ints[i], 8 + i * 2);
    else out.writeInt32LE(ints[i], 8 + i * 4);
  }
  return out;
}

function parseIntSetBlob(blob) {
  const enc = blob.readInt32LE(0);
  const n = blob.readInt32LE(4);
  const members = [];
  for (let i = 0; i < n; i++) {
    if (enc === 1) members.push(String(blob.readInt8(8 + i)));
    else if (enc === 2) members.push(String(blob.readInt16LE(8 + i * 2)));
    else members.push(String(blob.readInt32LE(8 + i * 4)));
  }
  return members;
}

/* ------------------------------ reader ------------------------------ */

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.off = 0;
  }

  eof() { return this.off >= this.buf.length; }

  byte() {
    if (this.off >= this.buf.length) throw new Error('RDB truncated (byte)');
    return this.buf[this.off++];
  }

  take(n) {
    if (this.off + n > this.buf.length) throw new Error('RDB truncated (take ' + n + ')');
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }

  u32le() { return this.take(4).readUInt32LE(0); }
  u64le() { return this.take(8).readBigUInt64LE(0); }
  f64le() { return this.take(8).readDoubleLE(0); }

  len() {
    const first = this.byte();
    const two = first & 0xc0;
    if (two === 0x00) return first & 0x3f;
    if (two === 0x40) return ((first & 0x3f) << 8) | this.byte();
    if (two === 0x80) return this.take(4).readUInt32BE(0);
    throw new Error('RDB special length not valid here');
  }

  // Returns a Buffer for raw strings; special int encodings become Buffers too.
  str() {
    const first = this.byte();
    if ((first & 0xc0) === 0xc0) {
      const sub = first & 0x3f;
      if (sub === 0) return Buffer.from(String(this.take(1).readInt8(0)), 'latin1');                       // int8
      if (sub === 1) return Buffer.from(String(this.take(2).readInt16LE(0)), 'latin1');
      if (sub === 2) return Buffer.from(String(this.take(4).readInt32LE(0)), 'latin1');
      if (sub === 3) throw new Error('RDB LZF strings not supported');
      throw new Error('RDB unknown string encoding ' + sub);
    }
    this.off--; // rewind into a plain length
    const n = this.len();
    return Buffer.from(this.take(n));
  }
}

/* ------------------------------ deserializer ------------------------------ */

// Load a snapshot buffer into the server's keyspace. Returns key count.
function deserialize(server, buf, { verifyChecksum = true } = {}) {
  if (buf.length < 9 + 9) throw new Error('RDB file too small');
  if (buf.toString('latin1', 0, 5) !== 'REDIS') throw new Error('RDB bad magic');
  const reader = new Reader(buf.subarray(9)); // skip "REDIS00xx"

  // Verify CRC: last 8 bytes are the checksum over everything before them.
  if (verifyChecksum && buf.length >= 17) {
    const stored = buf.readBigUInt64LE(buf.length - 8);
    const computed = crc64(buf.subarray(0, buf.length - 8));
    if (stored !== 0n && stored !== computed) {
      throw new Error('RDB CRC64 checksum mismatch');
    }
  }

  let expireAt = null;
  let db = server.keyspace.dbs[0];
  let loaded = 0;
  while (!reader.eof()) {
    const op = reader.byte();
    if (op === OPCODE.EOF) break;
    if (op === OPCODE.AUX) { reader.str(); reader.str(); continue; }
    if (op === OPCODE.RESIZEDB) { reader.len(); reader.len(); continue; }
    if (op === OPCODE.EXPIRETIME_MS) { expireAt = Number(reader.u64le()); continue; }
    if (op === OPCODE.SELECTDB32) { db = server.keyspace.dbs[reader.u32le()] || server.keyspace.dbs[0]; continue; }
    readObject(db, reader, op, expireAt);
    loaded++;
    expireAt = null;
  }
  return loaded;
}

function readObject(db, reader, type, expireAt) {
  const key = reader.str().toString('latin1');
  const now = Date.now();
  let obj = null;
  switch (type) {
    case TYPE.STRING:
      obj = new StrVal(reader.str());
      break;
    case TYPE.LIST: {
      obj = new ListVal();
      const n = reader.len();
      for (let i = 0; i < n; i++) obj.list.pushRight(reader.str());
      break;
    }
    case TYPE.SET: {
      obj = new SetVal();
      const n = reader.len();
      for (let i = 0; i < n; i++) obj.add(reader.str().toString('latin1'));
      break;
    }
    case TYPE.SET_INTSET: {
      obj = new SetVal();
      for (const m of parseIntSetBlob(reader.str())) obj.add(m);
      break;
    }
    case TYPE.HASH: {
      obj = new HashVal();
      const n = reader.len();
      for (let i = 0; i < n; i++) {
        const f = reader.str().toString('latin1');
        obj.map.set(f, reader.str());
      }
      break;
    }
    case TYPE.ZSET: {
      obj = new ZSetVal();
      const n = reader.len();
      for (let i = 0; i < n; i++) {
        const m = reader.str().toString('latin1');
        const score = parseFloat(reader.str().toString('latin1'));
        obj.add(m, score);
      }
      break;
    }
    case TYPE.ZSET_2: {
      obj = new ZSetVal();
      const n = reader.len();
      for (let i = 0; i < n; i++) {
        const m = reader.str().toString('latin1');
        const score = reader.f64le();
        obj.add(m, score);
      }
      break;
    }
    default:
      throw new Error('RDB unknown/compressed value type ' + type);
  }
  if (obj) {
    db.dict.set(key, obj);
    if (expireAt !== null) {
      if (expireAt <= now) db.dict.delete(key); // already expired on disk
      else db.expires.set(key, expireAt);
    }
  }
}

/* ------------------------------ file ops ------------------------------ */

// Blocking save. Returns bytes written.
function saveToFile(server, filePath) {
  const data = serialize(server);
  const tmp = filePath + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
  return data.length;
}

// Returns loaded key count, -1 when the file doesn't exist, -2 on load error
// with tolerateErrors.
function loadFromFile(server, filePath, opts = {}) {
  if (!fs.existsSync(filePath)) return -1;
  const data = fs.readFileSync(filePath);
  try {
    return deserialize(server, data, opts);
  } catch (e) {
    if (opts.tolerateErrors) {
      server.log('warning', 'RDB load failed: ' + e.message);
      return -2;
    }
    throw e;
  }
}

module.exports = {
  serialize, deserialize, saveToFile, loadFromFile, crc64,
  Writer, Reader, OPCODE, TYPE, RDB_MAGIC,
};
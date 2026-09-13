'use strict';

// Append-Only File persistence.
//
// Every mutating command is serialised (RESP) and appended. Fsync policies:
//   always   - fsync after every write
//   everysec - fsync at most once per second (default)
//   no       - let the OS flush
//
// A rewrite compacts the log to the live keyspace; the file is swapped
// atomically via rename().

const fs = require('fs');
const path = require('path');
const P = require('../protocol');

class Aof {
  constructor(server, config) {
    this.server = server;
    this.config = config;
    this.enabled = config.appendonly;
    const name = config.appendfilename || 'appendonly.aof';
    this.path = path.join(config.dir, name);
    this.fd = null;
    this.pendingParts = [];
    this.pendingBytes = 0;
    this.lastFsync = 0;
    this.fsyncPolicy = config.appendfsync || 'everysec';
    this.rewriting = false;
    this.bytesWritten = 0;
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    if (on) {
      this.enabled = true;
      this.rewrite();
      this.open();
    } else {
      this.flush();
      this.fsync();
      this.close();
      this.enabled = false;
    }
  }

  setFsync(policy) {
    if (!['always', 'everysec', 'no'].includes(policy)) return;
    this.fsyncPolicy = policy;
  }

  open() {
    if (this.fd !== null) return;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.closeSync(fs.openSync(this.path, 'a'));
    this.fd = fs.openSync(this.path, 'a');
    this.lastFsync = Date.now();
  }

  close() {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch {}
    this.fd = null;
  }

  feed(argv) {
    if (!this.enabled) return;
    if (this.fd === null) this.open();
    // Keep frames as separate buffers; concat once at flush time to avoid
    // O(n²) re-copying of the pending queue.
    this.pendingParts.push(P.encCmd(argv));
    this.pendingBytes += this.pendingParts[this.pendingParts.length - 1].length;
    if (this.fsyncPolicy === 'always') {
      this.flush();
      this.fsync();
    } else if (this.pendingBytes >= 64 * 1024) {
      this.flush();
    }
  }

  flush() {
    if (!this.pendingParts.length || this.fd === null) return;
    const out = this.pendingParts.length === 1 ? this.pendingParts[0] : Buffer.concat(this.pendingParts);
    fs.writeSync(this.fd, out);
    this.bytesWritten += out.length;
    this.pendingParts = [];
    this.pendingBytes = 0;
  }

  fsync() {
    if (this.fd === null) return;
    try { fs.fsyncSync(this.fd); } catch {}
    this.lastFsync = Date.now();
  }

  tick() {
    if (!this.enabled) return;
    this.flush();
    if (this.fsyncPolicy === 'everysec' && Date.now() - this.lastFsync >= 1000) this.fsync();
  }

  rewrite() {
    if (!this.enabled || this.rewriting) return;
    this.rewriting = true;
    try {
      this.writeSnapshot();
    } finally {
      this.rewriting = false;
    }
  }

  writeSnapshot() {
    const tmp = this.path + '.tmp.' + process.pid;
    const frames = require('./aof').snapshotFrames(this.server);
    const fd = fs.openSync(tmp, 'w');
    try {
      for (const frame of frames) fs.writeSync(fd, frame);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.close();
    fs.renameSync(tmp, this.path);
    this.open();
    this.bytesWritten = fs.statSync(this.path).size;
    this.server.log('notice', `AOF rewrite done (${frames.length} frames)`);
  }

  load() {
    if (!fs.existsSync(this.path)) return 0;
    const raw = fs.readFileSync(this.path);
    let usable = raw;
    try {
      const p = new P.RespParser({ maxBulk: 2 * 1024 * 1024 * 1024 });
      p.feed(raw);
      p.parse();
    } catch (e) {
      if (!this.config.aofLoadTruncated) throw e;
      this.server.log('warning', 'AOF has an incomplete tail; loading best-effort prefix');
      usable = this.constructor.largestParseablePrefix(raw, this.server);
    }
    const parser = new P.RespParser({ maxBulk: 2 * 1024 * 1024 * 1024 });
    parser.feed(usable);
    let frames = [];
    try { frames = parser.parse(); } catch (e) { frames = []; }
    let replayed = 0;
    for (const frame of frames) {
      if (!frame || frame.t !== '*') continue;
      const argv = frame.a.map((x) => x.b);
      try {
        this.server.execRaw(argv, { fromAof: true });
        replayed++;
      } catch (err2) {
        this.server.log('warning', `AOF command failed on replay (${err2.message})`);
      }
    }
    this.server.log('notice', `AOF loaded: ${replayed} commands replayed`);
    return replayed;
  }
}

// Serialise the entire keyspace as the command frames that rebuild it.
// Empty databases are skipped entirely so replay never leaves the selected
// database pointing at a high index.
function snapshotFrames(server) {
  const out = [];
  for (const db of server.keyspace.all()) {
    const now = Date.now();
    const keys = db.allKeys(now);
    if (keys.length === 0) continue;
    out.push(P.encCmd(['SELECT', String(db.id)]));
    for (const key of keys) {
      const obj = db.get(key, now);
      if (!obj) continue;
      out.push(...snapshotCommands(key, obj));
      const ttl = db.expires.get(key);
      if (ttl !== undefined) out.push(P.encCmd(['PEXPIREAT', key, String(ttl)]));
    }
  }
  return out;
}

function snapshotCommands(key, obj) {
  const out = [];
  const k = Buffer.from(key, 'latin1');
  switch (obj.type) {
    case 'string': out.push(P.encCmd(['SET', k, obj.buf])); break;
    case 'list': {
      const items = obj.list.toArray();
      if (items.length) out.push(P.encCmd(['RPUSH', k, ...items]));
      break;
    }
    case 'hash': {
      const parts = [];
      for (const [f, v] of obj.map) parts.push(Buffer.from(f, 'latin1'), v);
      if (parts.length) out.push(P.encCmd(['HSET', k, ...parts]));
      break;
    }
    case 'set': {
      const ms = obj.members().map((m) => Buffer.from(m, 'latin1'));
      if (ms.length) out.push(P.encCmd(['SADD', k, ...ms]));
      break;
    }
    case 'zset': {
      const parts = [];
      for (const { member, score } of obj.sl.toArray()) {
        parts.push(Buffer.from(String(score), 'latin1'), Buffer.from(member, 'latin1'));
      }
      if (parts.length) out.push(P.encCmd(['ZADD', k, ...parts]));
      break;
    }
  }
  return out;
}

// Binary search for the largest prefix [0,n) that parses cleanly.
function largestParseablePrefix(raw) {
  let lo = 0, hi = raw.length, best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const parser = new P.RespParser({ maxBulk: 2 * 1024 * 1024 * 1024 });
    try {
      parser.feed(raw.subarray(0, mid));
      parser.parse();
      const consumed = mid - parser.buf.length;
      if (consumed > best) best = consumed;
      if (mid === raw.length && parser.buf.length === 0) return raw.length;
      if (parser.buf.length === 0) lo = mid + 1;
      else hi = mid - 1;
    } catch (e) {
      hi = mid - 1;
    }
  }
  return best;
}

Aof.largestParseablePrefix = largestParseablePrefix;

module.exports = { Aof, snapshotFrames, snapshotCommands, largestParseablePrefix };
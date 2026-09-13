'use strict';

// Value objects stored in the dictionary. Each key maps to one of these.
//
//   string – raw bytes plus an optional cached integer representation
//   list   – LList of Buffers
//   hash   – Map<string,Buffer> using latin1 keys
//   set    – either an IntSet (all-int) or a Map<string,true>
//   zset   – Map<member,score> + SkipList<score,member>
//
// Every object carries `ttl` (absolute ms timestamp) or null. Values may also
// carry an `idletime`/`freq` for the LRU/LFU eviction policies.

const { LList } = require('./list');
const { SkipList } = require('./zskiplist');
const { IntSet } = require('./intset');

class XObject {
  constructor(type) {
    this.type = type;
    this.ttl = null;         // absolute ms, null = persistent
    this.idletime = 0;       // ms since last access (LRU)
    this.freq = 0;           // LFU counter
  }
}

class StrVal extends XObject {
  constructor(buf, extra = {}) {
    super('string');
    this.buf = buf;
    this._int = extra.int !== undefined ? extra.int : null; // cached integer or null
  }
  get int() {
    if (this._int === null) {
      const s = this.buf.toString('latin1');
      this._int = /^-?\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
    }
    return this._int;
  }
}

class ListVal extends XObject {
  constructor() { super('list'); this.list = new LList(); }
}

class HashVal extends XObject {
  constructor() { super('hash'); this.map = new Map(); }
}

class SetVal extends XObject {
  constructor() { super('set'); this.is = new IntSet(); this.map = null; }

  get length() { return this.map ? this.map.size : this.is.length; }

  // Ensure the hash encoding is in use.
  _toMap() {
    if (!this.map) {
      this.map = new Map();
      for (const v of this.is.toArray()) this.map.set(String(v), true);
      this.is = null;
    }
    return this.map;
  }

  has(member) {
    if (this.map) return this.map.has(member);
    if (/^-?\d+$/.test(member) && Number.isSafeInteger(Number(member))) return this.is.has(Number(member));
    return false;
  }

  add(member) {
    if (this.map) {
      if (this.map.has(member)) return false;
      this.map.set(member, true);
      return true;
    }
    if (/^-?\d+$/.test(member) && Number.isSafeInteger(Number(member))) {
      return this.is.add(Number(member));
    }
    // Upgrade to hash encoding.
    this._toMap();
    if (!this.map.has(member)) { this.map.set(member, true); return true; }
    return false;
  }

  remove(member) {
    if (this.map) return this.map.delete(member);
    if (/^-?\d+$/.test(member) && Number.isSafeInteger(Number(member))) return this.is.remove(Number(member));
    return false;
  }

  members() {
    return this.map ? Array.from(this.map.keys()) : this.is.toArray().map(String);
  }

  pickRandom(rng) {
    if (this.map) {
      const ks = Array.from(this.map.keys());
      return ks.length ? ks[Math.floor(rng() * ks.length)] : undefined;
    }
    const v = this.is.pickRandom(rng);
    return v === undefined ? undefined : String(v);
  }

  popRandom(rng) {
    if (this.map) {
      const ks = Array.from(this.map.keys());
      if (!ks.length) return undefined;
      const k = ks[Math.floor(rng() * ks.length)];
      this.map.delete(k);
      return k;
    }
    const v = this.is.popRandom(rng);
    return v === undefined ? undefined : String(v);
  }
}

class ZSetVal extends XObject {
  constructor() {
    super('zset');
    this.dict = new Map();   // member -> score (number)
    this.sl = new SkipList();
  }

  get length() { return this.dict.size; }

  getScore(member) {
    const s = this.dict.get(member);
    return s === undefined ? null : s;
  }

  has(member) { return this.dict.has(member); }

  // Insert-or-update. Returns { added: bool, oldScore }.
  add(member, score) {
    const old = this.dict.get(member);
    if (old !== undefined) {
      if (old === score) return { added: false, old };
      this.sl.delete(old, member);
      this.sl.insert(score, member);
      this.dict.set(member, score);
      return { added: false, old };
    }
    this.dict.set(member, score);
    this.sl.insert(score, member);
    return { added: true, old: undefined };
  }

  remove(member) {
    const score = this.dict.get(member);
    if (score === undefined) return false;
    this.dict.delete(member);
    this.sl.delete(score, member);
    return true;
  }

  count() { return this.dict.size; }
}

module.exports = { XObject, StrVal, ListVal, HashVal, SetVal, ZSetVal };
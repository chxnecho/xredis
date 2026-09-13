'use strict';

const { StrVal, ListVal, HashVal, SetVal, ZSetVal } = require('./objects');

// A database (named key space). Redis keeps one dict of keys + an auxiliary
// expire dict; we do the same. Keys are latin1 strings.

class Db {
  constructor(id) {
    this.id = id;
    this.dict = new Map();      // key -> XObject
    this.expires = new Map();   // key -> absolute ms timestamp
  }

  get size() { return this.dict.size; }

  // Look up with lazy expiry. Returns { obj, fresh } (fresh=false if the key
  // just expired and was removed), or null when missing.
  lookup(key, now = Date.now()) {
    const ex = this.expires.get(key);
    if (ex !== undefined && ex <= now) {
      this.dict.delete(key);
      this.expires.delete(key);
      return null;
    }
    return this.dict.get(key) || null;
  }

  exists(key, now = Date.now()) { return this.lookup(key, now) !== null; }

  // Set with optional TTL (absolute ms). Returns the object.
  set(key, obj) {
    this.dict.set(key, obj);
    return obj;
  }

  // Remove a key (any type) — the only mutator for deletions so the expire
  // index stays consistent.
  del(key) {
    this.dict.delete(key);
    this.expires.delete(key);
  }

  get(key, now) { return this.lookup(key, now); }

  getTTL(key, now = Date.now()) {
    const ex = this.expires.get(key);
    if (ex === undefined) return -1;
    if (ex <= now) {
      this.dict.delete(key);
      this.expires.delete(key);
      return -2;
    }
    return ex - now;
  }

  setTTL(key, ttlMs) {
    if (this.expires.has(key) || this.dict.has(key)) {
      if (ttlMs <= 0) this.del(key);
      else this.expires.set(key, Date.now() + ttlMs);
      return true;
    }
    return false;
  }

  persist(key, now = Date.now()) {
    if (this.lookup(key, now) === null) return false;
    if (this.expires.has(key)) { this.expires.delete(key); return true; }
    return false;
  }

  // Fetch all non-expired keys (used by KEYS / SCAN / persistence).
  allKeys(now = Date.now()) {
    const out = [];
    for (const [k, v] of this.dict) {
      const ex = this.expires.get(k);
      if (ex !== undefined && ex <= now) {
        this.dict.delete(k);
        this.expires.delete(k);
        continue;
      }
      void v;
      out.push(k);
    }
    return out;
  }

  // Random key (SRANDMEMBER/DBSIZE semantics use it occasionally).
  randomKey(rng, now = Date.now()) {
    const keys = this.allKeys(now);
    if (!keys.length) return null;
    return keys[Math.floor(rng() * keys.length)];
  }

  flush() {
    this.dict.clear();
    this.expires.clear();
  }

  // Expire a subset of volatile keys (active expiry). Returns count removed.
  activeExpire(now = Date.now(), sampleLimit = 20) {
    let removed = 0;
    const volatile = [];
    for (const [k, ex] of this.expires) {
      if (ex <= now) volatile.push(k);
    }
    for (let i = 0; i < Math.min(volatile.length, sampleLimit); i++) {
      const k = volatile[i];
      const ex = this.expires.get(k);
      if (ex !== undefined && ex <= now) {
        this.dict.delete(k);
        this.expires.delete(k);
        removed++;
      }
    }
    return removed;
  }
}

// A set of databases plus cross-cutting server bookkeeping.
class KeySpace {
  constructor(count = 1) {
    this.dbs = [];
    for (let i = 0; i < count; i++) this.dbs.push(new Db(i));
    this.selected = 0;
  }

  current() { return this.dbs[this.selected]; }

  all() { return this.dbs; }

  flushAll() { for (const db of this.dbs) db.flush(); }
}

module.exports = { Db, KeySpace };
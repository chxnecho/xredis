'use strict';

// Memory-efficient integer set: a sorted array of int64 values.
// Redis stores a set as an intset while all members fit in int64 and the count
// is small; it upgrades to the hash-table encoding otherwise. We mirror that
// so SMEMBERS/SISMEMBER on numeric sets stay compact and fast.

class IntSet {
  constructor() {
    this.arr = [];      // sorted ascending, unique
  }

  get type() { return 'intset'; }
  get length() { return this.arr.length; }
  has(v) { return binarySearch(this.arr, v) >= 0; }
  min() { return this.arr.length ? this.arr[0] : undefined; }
  max() { return this.arr.length ? this.arr[this.arr.length - 1] : undefined; }

  add(v) {
    const i = binarySearch(this.arr, v);
    if (i >= 0) return false;
    this.arr.splice(-i - 1, 0, v);
    return true;
  }

  remove(v) {
    const i = binarySearch(this.arr, v);
    if (i < 0) return false;
    this.arr.splice(i, 1);
    return true;
  }

  pickRandom(rng) {
    if (this.arr.length === 0) return undefined;
    return this.arr[Math.floor(rng() * this.arr.length)];
  }

  popRandom(rng) {
    const i = Math.floor(rng() * this.arr.length);
    return this.arr.splice(i, 1)[0];
  }

  toArray() { return this.arr.slice(); }
}

function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid + 1; else hi = mid - 1;
  }
  return -(lo + 1);
}

module.exports = { IntSet, binarySearch };
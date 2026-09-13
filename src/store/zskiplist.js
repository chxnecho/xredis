'use strict';

// Redis-style skip list — the backing structure for zset.
//
// Ordering is by (score, member) exactly like Redis (ties broken by member
// string). Forward pointers at each level live on the Node itself at key `i`,
// so no wrapper objects are needed. For simplicity rank queries walk the
// search path counting elements rather than tracking per-node spans (that is
// O(log n) in expectation). Implementation mirrors the classic zskiplist.

const MAX_LEVEL = 32;

function randomLevel() {
  let lvl = 1;
  while (Math.random() < 0.25 && lvl < MAX_LEVEL) lvl++;
  return lvl;
}

class SkipList {
  constructor() {
    this.head = { level: MAX_LEVEL, score: 0, member: null, backward: null };
    for (let i = 0; i < MAX_LEVEL; i++) this.head[i] = null;
    this.length = 0;
    this.level = 1;
    this.tail = null;
  }

  // Common downward walk collecting the nodes whose forward pointers change.
  _update(score, member) {
    const update = new Array(MAX_LEVEL);
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x[i] && (x[i].score < score || (x[i].score === score && x[i].member < member))) {
        x = x[i];
      }
      update[i] = x;
    }
    return update;
  }

  // Bottom-level node satisfying (score, member) >= query, or null.
  firstGte(score, member) {
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x[i] && (x[i].score < score || (x[i].score === score && x[i].member < member))) {
        x = x[i];
      }
    }
    return x[0] || null;
  }

  // Bottom-level node satisfying score > `score`, or null.
  firstGt(score) {
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x[i] && x[i].score <= score) x = x[i];
    }
    return x[0] || null;
  }

  // Number of elements strictly before `query` — i.e. its 0-based rank.
  rank(score, member) {
    let x = this.head, cnt = 0;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x[i] && (x[i].score < score || (x[i].score === score && x[i].member < member))) {
        cnt += 1;
        x = x[i];
      }
    }
    return cnt;
  }

  insert(score, member) {
    const update = this._update(score, member);
    const lvl = randomLevel();
    if (lvl > this.level) {
      for (let i = this.level; i < lvl; i++) update[i] = this.head;
      this.level = lvl;
    }
    const n = { score, member, backward: null };
    n.level = lvl;
    for (let i = 0; i < lvl; i++) {
      n[i] = update[i][i];
      update[i][i] = n;
    }
    n.backward = update[0] === this.head ? null : update[0];
    if (n[0]) n[0].backward = n; else this.tail = n;
    this.length++;
    return n;
  }

  delete(score, member) {
    const update = this._update(score, member);
    const x = update[0][0];
    if (!x || x.score !== score || x.member !== member) return false;
    for (let i = 0; i < this.level; i++) {
      if (update[i][i] === x) update[i][i] = x[i];
    }
    if (x[0]) x[0].backward = x.backward; else this.tail = x.backward;
    while (this.level > 1 && this.head[this.level - 1] === null) this.level--;
    this.length--;
    return true;
  }

  // Node at 0-based rank, or null. O(n) deliberately.
  elementAt(rank) {
    if (rank < 0 || rank >= this.length) return null;
    let x = this.head[0];
    for (let i = 0; i < rank; i++) x = x[0];
    return x || null;
  }

  toArray() {
    const out = [];
    let x = this.head[0];
    while (x) { out.push({ member: x.member, score: x.score }); x = x[0]; }
    return out;
  }
}

module.exports = { SkipList, MAX_LEVEL };
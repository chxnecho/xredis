'use strict';

// Doubly-linked list — the backing structure for values of type `list`.
// O(1) head/tail push & pop, O(n) indexed access (the classic pre-quicklist
// Redis design).

class LNode {
  constructor(v) {
    this.v = v;
    this.prev = null;
    this.next = null;
  }
}

class LList {
  constructor() {
    this.head = null;
    this.tail = null;
    this.len = 0;
  }

  get length() { return this.len; }

  isEmpty() { return this.len === 0; }

  pushRight(v) {
    const n = new LNode(v);
    if (this.tail) { this.tail.next = n; n.prev = this.tail; } else { this.head = n; }
    this.tail = n;
    this.len++;
  }

  pushLeft(v) {
    const n = new LNode(v);
    if (this.head) { this.head.prev = n; n.next = this.head; } else { this.tail = n; }
    this.head = n;
    this.len++;
  }

  popLeft() {
    if (!this.head) return null;
    const n = this.head;
    this.head = n.next;
    if (this.head) this.head.prev = null; else this.tail = null;
    this.len--;
    return n.v;
  }

  popRight() {
    if (!this.tail) return null;
    const n = this.tail;
    this.tail = n.prev;
    if (this.tail) this.tail.next = null; else this.head = null;
    this.len--;
    return n.v;
  }

  // 0-based index, non-negative (callers normalise negative indexes first).
  nodeAt(i) {
    if (this.head && i < this.len - i) {
      let n = this.head;
      for (let k = 0; k < i; k++) n = n.next;
      return n;
    }
    let n = this.tail;
    for (let k = this.len - 1; k > i; k--) n = n.prev;
    return n;
  }

  insertBefore(node, v) {
    const n = new LNode(v);
    n.prev = node.prev;
    n.next = node;
    if (node.prev) node.prev.next = n; else this.head = n;
    node.prev = n;
    this.len++;
    return n;
  }

  insertAfter(node, v) {
    const n = new LNode(v);
    n.prev = node;
    n.next = node.next;
    if (node.next) node.next.prev = n; else this.tail = n;
    node.next = n;
    this.len++;
    return n;
  }

  // Remove a detached node (its own links are torn down here for hygiene).
  remove(node) {
    if (node.prev) node.prev.next = node.next; else this.head = node.next;
    if (node.next) node.next.prev = node.prev; else this.tail = node.prev;
    node.prev = node.next = null;
    this.len--;
  }

  toArray() {
    const out = new Array(this.len);
    let n = this.head, i = 0;
    while (n) { out[i++] = n.v; n = n.next; }
    return out;
  }

  clear() {
    this.head = this.tail = null;
    this.len = 0;
  }
}

module.exports = { LList, LNode };
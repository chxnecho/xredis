'use strict';

// Replication backlog — a fixed-size ring buffer of the replication command
// stream. Replicas that disconnect briefly can reconnect with PSYNC and be
// resynchronised from the backlog instead of receiving a full snapshot.
//
// Offsets are absolute byte positions in the (logical) replication stream.
// `masterOffset` is the offset *after* the last byte fed; a replica asking for
// offset X receives backlog bytes [X, masterOffset).

class ReplBacklog {
  constructor(size = 1024 * 1024) {
    this.size = Math.max(1024, size);
    this.buf = Buffer.alloc(this.size);
    this.writePos = 0;      // ring index of the next write
    this.used = 0;          // valid bytes currently stored
    this.masterOffset = 0;  // global stream offset after last feed
  }

  // Global offset of the oldest byte still in the ring.
  oldestOffset() { return this.masterOffset - this.used; }

  feed(bytes) {
    if (bytes.length === 0) return;
    let off = 0;
    while (off < bytes.length) {
      const n = Math.min(bytes.length - off, this.size - this.writePos);
      bytes.copy(this.buf, this.writePos, off, off + n);
      this.writePos = (this.writePos + n) % this.size;
      off += n;
    }
    this.used = Math.min(this.size, this.used + bytes.length);
    this.masterOffset += bytes.length;
  }

  // Returns a Buffer of backlog bytes [from, to), or null when `from` has
  // already been evicted (the replica needs a full sync).
  slice(from, to = this.masterOffset) {
    if (from < this.oldestOffset() || from > this.masterOffset || to > this.masterOffset || from > to) {
      return null;
    }
    const total = to - from;
    if (total === 0) return Buffer.alloc(0);
    // Ring position of byte `from`.
    const back = this.masterOffset - from; // bytes behind the write cursor
    const startPos = ((this.writePos - back) % this.size + this.size) % this.size;
    const firstChunk = Math.min(total, this.size - startPos);
    if (firstChunk >= total) {
      return Buffer.from(this.buf.subarray(startPos, startPos + total));
    }
    return Buffer.concat([
      Buffer.from(this.buf.subarray(startPos, startPos + firstChunk)),
      Buffer.from(this.buf.subarray(0, total - firstChunk)),
    ]);
  }

  // Can a replica at `offset` be resynchronised partially?
  canPartialSync(offset) {
    if (offset > this.masterOffset) return false; // replica is ahead: impossible
    return offset >= this.oldestOffset();
  }
}

module.exports = { ReplBacklog };
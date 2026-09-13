'use strict';

// Minimal RESP client used for integration tests and the CLI: connects,
// sends commands, parses RESP replies (RESP2 and RESP3 frames).

const net = require('net');
const { RespParser, encCmd } = require('./protocol');

class Client {
  constructor({ host = '127.0.0.1', port = 6379, password = '' } = {}) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.parser = new RespParser();
    this.pending = [];         // queue of { resolve, reject }
    this.pendingFrom = 0;      // cursor into `pending` (avoids O(n) shifts)
    this.pendingCount = 0;
    this.closedByServer = false;
    this.closedError = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port });
      this.socket.on('connect', () => {
        if (this.password) {
          this.send(['AUTH', this.password]).then(() => resolve(), reject);
        } else {
          resolve();
        }
      });
      // Both events reject the connect promise if it is still pending (the
      // Promise API ignores redundant settles). They also fail any requests
      // that were already sent.
      this.socket.on('error', (e) => {
        this.closedError = e instanceof Error ? e : new Error(String(e));
        this.closedByServer = true;
        this.failPending(this.closedError);
        reject(this.closedError);
      });
      this.socket.on('close', () => {
        this.closedByServer = true;
        const err = this.closedError || new Error('connection closed');
        this.failPending(err);
        reject(err);
      });
      this.socket.on('data', (chunk) => {
        this.parser.feed(chunk);
        let vals;
        try {
          vals = this.parser.parse();
        } catch (e) {
          // A protocol error means the stream is unusable: fail every request
          // waiting on this connection instead of hanging forever.
          this.failPending(e);
          this.socket.destroy();
          return;
        }
        for (const v of vals) {
          const entry = this.pending[this.pendingFrom++];
          if (this.pendingFrom > 1024 && this.pendingFrom === this.pending.length) {
            this.pending = []; this.pendingFrom = 0;
          }
          if (entry) entry.resolve(decode(v));
        }
      });
    });
  }

  // Reject every request that has been sent but not yet answered.
  failPending(err) {
    for (let i = this.pendingFrom; i < this.pending.length; i++) {
      const entry = this.pending[i];
      if (entry && entry.reject) entry.reject(err);
    }
    this.pending = [];
    this.pendingFrom = 0;
  }

  send(argv) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('not connected'));
        return;
      }
      if (this.closedByServer) {
        reject(this.closedError || new Error('connection closed'));
        return;
      }
      this.pending.push({
        resolve: (reply) => {
          if (reply && reply.__error) reject(reply.__error);
          else resolve(reply);
        },
        reject,
      });
      this.pendingCount++;
      this.socket.write(encCmd(argv));
    });
  }

  // Wait for the next inbound frame without sending anything (used to capture
  // out-of-band pub/sub messages).
  next(timeout = 2000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.indexOf(entry);
        if (i !== -1) { this.pending.splice(i, 1); reject(new Error('next() timed out')); }
      }, timeout);
      const entry = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.pending.push(entry);
    });
  }

  close() {
    if (this.socket) this.socket.destroy();
  }
}

// Turn a parsed RESP value into a friendly JS value (RESP2 + RESP3).
function decode(v) {
  if (!v) return null;
  switch (v.t) {
    case '+': return v.s;
    case '-': {
      const e = new Error(v.s);
      e.xredisError = true;
      e.message = v.s;
      return { __error: e };
    }
    case ':': return v.n;
    case '$': return v.b === null ? null : v.b;
    case '*': {
      if (v.a === null) return null;
      return v.a.map(decode);
    }
    // ----- RESP3 -----
    case '_': return null;                                     // typed null
    case '#': return v.b === true || v.b === 't';              // bool
    case ',': {                                                // double
      const d = v.d;
      if (typeof d === 'number') return d;
      const s = v.b ? v.b.toString('latin1') : '0';
      if (s === 'nan') return NaN;
      if (s === 'inf') return Infinity;
      if (s === '-inf') return -Infinity;
      return parseFloat(s);
    }
    case '=': return v.b === null ? null : v.b;                // verbatim string
    case '!': {                                                // blob error
      const e = new Error(v.s || '');
      e.xredisError = true;
      e.message = v.s || '';
      return { __error: e };
    }
    case '(': return v.s;                                      // bignumber (as string)
    case '~': case '>': {                                      // set / push
      if (v.a === null) return null;
      return v.a.map(decode);
    }
    case '%': {                                                // map
      if (v.a === null) return null;
      const o = {};
      for (let i = 0; i + 1 < v.a.length; i += 2) {
        const k = v.a[i];
        o[k && k.t === ':' ? String(k.n) : (k && k.b ? k.b.toString('utf8') : '')] = decode(v.a[i + 1]);
      }
      return o;
    }
    default: return null;
  }
}

module.exports = { Client, decode };
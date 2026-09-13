'use strict';

// Redis Serialization Protocol (RESP2 + RESP3) — the wire protocol.
// Encodes replies and incrementally parses client requests, correctly handling
// partial reads (half packets), TCP pipelining (many commands per packet) and
// inline (telnet-style) commands.
//
// RESP3 additions: parser accepts the new type bytes (%, |, #, ,, _, =, >, ~,
// (, !) so a RESP3 client can talk to us; encoder can emit them when the
// connection negotiated proto 3 via HELLO 3.

const CRLF = Buffer.from('\r\n');

/* ---------------------------- encoding ---------------------------- */

function encSimple(s) { return Buffer.from('+' + s + '\r\n', 'utf8'); }
function encError(s) { return Buffer.from('-' + s + '\r\n', 'utf8'); }
function encInt(n) { return Buffer.from(':' + n + '\r\n', 'latin1'); }
function encNull() { return Buffer.from('$-1\r\n', 'latin1'); }
function encNullArray() { return Buffer.from('*-1\r\n', 'latin1'); }
// RESP3 null (typed null, `_\r\n`). Used when the peer negotiated proto 3.
function encNull3() { return Buffer.from('_\r\n', 'latin1'); }
function encBool(b) { return Buffer.from('#' + (b ? 't' : 'f') + '\r\n', 'latin1'); }
function encDouble(n) {
  if (Number.isNaN(n)) return Buffer.from(',nan\r\n', 'latin1');
  if (n === Infinity) return Buffer.from(',inf\r\n', 'latin1');
  if (n === -Infinity) return Buffer.from(',-inf\r\n', 'latin1');
  return Buffer.from(',' + String(n) + '\r\n', 'latin1');
}
function encVerbatim(fmt, data) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(String(data), 'utf8');
  const head = Buffer.from('=' + (3 + 1 + data.length) + '\r\n' + fmt + ':' , 'latin1');
  return Buffer.concat([head, data, CRLF]);
}
function encMap(pairs) {
  // pairs: flat array [k1, v1, k2, v2, ...] of pre-encoded buffers.
  const head = Buffer.from('%' + (pairs.length / 2) + '\r\n', 'latin1');
  return pairs.length === 0 ? head : Buffer.concat([head, ...pairs]);
}
function encSet(parts) {
  const head = Buffer.from('~' + parts.length + '\r\n', 'latin1');
  return parts.length === 0 ? head : Buffer.concat([head, ...parts]);
}
function encPush(parts) {
  const head = Buffer.from('>' + parts.length + '\r\n', 'latin1');
  return parts.length === 0 ? head : Buffer.concat([head, ...parts]);
}

function encBulk(buf) {
  if (buf === null || buf === undefined) return encNull();
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
  const head = Buffer.from('$' + buf.length + '\r\n', 'latin1');
  return Buffer.concat([head, buf, CRLF]);
}

function encArr(parts) {
  if (parts === null || parts === undefined) return encNullArray();
  const head = Buffer.from('*' + parts.length + '\r\n', 'latin1');
  return parts.length === 0 ? head : Buffer.concat([head, ...parts]);
}

function encCmd(argv) {
  // Single-allocation encoding: precompute sizes, then fill one buffer.
  // (The previous version allocated 3 buffers per argument plus two concats.)
  const bufs = new Array(argv.length);
  const heads = new Array(argv.length);
  let total = 1 + String(argv.length).length + 2;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'latin1');
    bufs[i] = b;
    heads[i] = '$' + b.length + '\r\n';
    total += heads[i].length + b.length + 2;
  }
  const out = Buffer.allocUnsafe(total);
  let off = out.write('*' + argv.length + '\r\n', 0, 'latin1');
  for (let i = 0; i < bufs.length; i++) {
    off += out.write(heads[i], off, 'latin1');
    bufs[i].copy(out, off);
    off += bufs[i].length;
    off += out.write('\r\n', off, 'latin1');
  }
  return out;
}

function encErrLike(e) {
  if (e instanceof Error) return encError(e.xrCode ? e.xrCode + ' ' + e.message : 'ERR ' + e.message);
  return encError(String(e));
}

/* ---------------------------- parsing ---------------------------- */

class ProtocolError extends Error {
  constructor(msg) { super(msg); this.xrProtocol = true; }
}

class Incomplete extends Error {
  constructor() { super('incomplete input'); this.xrIncomplete = true; }
}

// Find the next CRLF (or bare LF) starting at `from`.
function readLine(buf, from) {
  const idx = buf.indexOf(0x0a, from);
  if (idx === -1) return null;
  let contentEnd = idx;
  if (contentEnd > from && buf[contentEnd - 1] === 0x0d) contentEnd--;
  return { line: buf.subarray(from, contentEnd), end: idx + 1 };
}

const MAX_ARRAY = 1024 * 1024;

function parseValue(buf, off, maxBulk) {
  if (off >= buf.length) throw new Incomplete();
  const t = buf[off];
  if (t === 0x2a) return parseArray(buf, off, maxBulk);
  if (t === 0x24) return parseBulk(buf, off, maxBulk);
  if (t === 0x2b) return parseCapLine(buf, off, 0x2b);
  if (t === 0x2d) return parseCapLine(buf, off, 0x2d);
  if (t === 0x3a) return parseCapLine(buf, off, 0x3a);
  // RESP3 aggregate / scalar types. We parse them generically (recursive for
  // aggregates) so RESP3 clients can send e.g. maps/sets. Commands using them
  // are flattened to bulk strings downstream.
  if (t === 0x25) return parseResp3Agg(buf, off, maxBulk, '%'); // map
  if (t === 0x7e) return parseResp3Agg(buf, off, maxBulk, '~'); // set
  if (t === 0x3e) return parseResp3Agg(buf, off, maxBulk, '>'); // push
  if (t === 0x7c) return parseResp3Agg(buf, off, maxBulk, '|'); // attribute
  if (t === 0x28) return parseResp3Agg(buf, off, maxBulk, '('); // bignumber (as str)
  if (t === 0x23 || t === 0x2c || t === 0x5f) return parseResp3Line(buf, off, maxBulk); // bool/double/null
  if (t === 0x3d || t === 0x21) return parseResp3Blob(buf, off, maxBulk); // verbatim/blob-error
  throw new ProtocolError(`Protocol error: expected a RESP type character, got: ${String.fromCharCode(t)}`);
}

function parseCapLine(buf, off, type) {
  const line = readLine(buf, off + 1);
  if (line === null) throw new Incomplete();
  if (type === 0x3a) {
    const s = line.line.toString('latin1');
    if (!/^-?\d+$/.test(s)) throw new ProtocolError(`Protocol error: invalid integer '${s}'`);
    return { value: { t: ':', n: Number(s) }, offset: line.end };
  }
  return { value: { t: type === 0x2d ? '-' : '+', s: line.line.toString('utf8') }, offset: line.end };
}

function parseBulk(buf, off, maxBulk) {
  const line = readLine(buf, off + 1);
  if (line === null) throw new Incomplete();
  const s = line.line.toString('latin1');
  if (!/^-?\d+$/.test(s)) throw new ProtocolError(`Protocol error: invalid bulk length '${s}'`);
  const len = Number(s);
  if (len === -1) return { value: { t: '$', b: null }, offset: line.end };
  if (len < -1 || len > maxBulk) throw new ProtocolError('Protocol error: invalid bulk length');
  if (buf.length - line.end < len + 2) throw new Incomplete();
  // The payload must be followed by a real CRLF terminator, otherwise the
  // declared length does not match the framing (protocol error, not partial).
  if (buf[line.end + len] !== 0x0d || buf[line.end + len + 1] !== 0x0a) {
    throw new ProtocolError('Protocol error: bulk payload not terminated by CRLF');
  }
  const data = buf.subarray(line.end, line.end + len);
  return { value: { t: '$', b: data }, offset: line.end + len + 2 };
}

function parseArray(buf, off, maxBulk) {
  const line = readLine(buf, off + 1);
  if (line === null) throw new Incomplete();
  const s = line.line.toString('latin1');
  if (s === '-1') return { value: { t: '*', a: null }, offset: line.end };
  if (!/^\d+$/.test(s)) throw new ProtocolError(`Protocol error: invalid multibulk length '${s}'`);
  const count = Number(s);
  if (count > MAX_ARRAY) throw new ProtocolError('Protocol error: invalid multibulk length');
  const a = new Array(count);
  let o = line.end;
  for (let i = 0; i < count; i++) {
    const r = parseValue(buf, o, maxBulk);
    a[i] = r.value;
    o = r.offset;
  }
  return { value: { t: '*', a }, offset: o };
}

// RESP3 single-line scalars: `#t/#f` bool, `,3.14` double, `_\r\n` null.
function parseResp3Line(buf, off) {
  const t = buf[off];
  const line = readLine(buf, off + 1);
  if (line === null) throw new Incomplete();
  const s = line.line.toString('latin1');
  if (t === 0x23) {
    if (s !== 't' && s !== 'f') throw new ProtocolError(`Protocol error: invalid boolean '${s}'`);
    return { value: { t: '#', b: s === 't' }, offset: line.end };
  }
  if (t === 0x2c) {
    if (s === 'nan') return { value: { t: ',', d: NaN }, offset: line.end };
    if (s === 'inf') return { value: { t: ',', d: Infinity }, offset: line.end };
    if (s === '-inf') return { value: { t: ',', d: -Infinity }, offset: line.end };
    const n = Number(s);
    if (!Number.isFinite(n) && s !== '0') throw new ProtocolError(`Protocol error: invalid double '${s}'`);
    return { value: { t: ',', d: n }, offset: line.end };
  }
  // `_` typed null (empty line).
  if (s.length !== 0) throw new ProtocolError('Protocol error: invalid null');
  return { value: { t: '_', b: null }, offset: line.end };
}

// RESP3 blob flavours: `=<len>\r\n<fmt>:<data>\r\n` verbatim, `!<len>\r\n<data>\r\n`.
function parseResp3Blob(buf, off, maxBulk) {
  const t = buf[off];
  const line = readLine(buf, off + 1);
  if (line === null) throw new Incomplete();
  const s = line.line.toString('latin1');
  if (!/^\d+$/.test(s)) throw new ProtocolError('Protocol error: invalid blob length');
  const len = Number(s);
  if (len > maxBulk) throw new ProtocolError('Protocol error: invalid bulk length');
  if (buf.length - line.end < len + 2) throw new Incomplete();
  if (buf[line.end + len] !== 0x0d || buf[line.end + len + 1] !== 0x0a) {
    throw new ProtocolError('Protocol error: blob payload not terminated by CRLF');
  }
  const data = buf.subarray(line.end, line.end + len);
  if (t === 0x3d) {
    const idx = data.indexOf(0x3a); // fmt ':' payload
    const fmt = idx === -1 ? '' : data.subarray(0, idx).toString('latin1');
    const payload = idx === -1 ? data : data.subarray(idx + 1);
    return { value: { t: '=', fmt, b: Buffer.from(payload) }, offset: line.end + len + 2 };
  }
  return { value: { t: '!', s: Buffer.from(data).toString('utf8') }, offset: line.end + len + 2 };
}

// RESP3 aggregates: `%<n>\r\n` map (2n children), `~<n>` set, `><n>` push,
// `|<n>` attribute (2n+1 children), `(<len>\r\n<digits>\r\n` bignumber.
function parseResp3Agg(buf, off, maxBulk, kind) {
  if (kind === '(') {
    const line = readLine(buf, off + 1);
    if (line === null) throw new Incomplete();
    const s = line.line.toString('latin1');
    if (!/^\d+$/.test(s)) throw new ProtocolError('Protocol error: invalid bignumber');
    return { value: { t: '(', s }, offset: line.end };
  }
  const line = readLine(buf, off + 1);
  if (line === null) throw new Incomplete();
  const s = line.line.toString('latin1');
  if (!/^\d+$/.test(s)) throw new ProtocolError('Protocol error: invalid aggregate length');
  const count = Number(s);
  if (count > MAX_ARRAY) throw new ProtocolError('Protocol error: invalid multibulk length');
  const want = kind === '%' || kind === '|' ? count * 2 + (kind === '|' ? 1 : 0) : count;
  const a = new Array(want);
  let o = line.end;
  for (let i = 0; i < want; i++) {
    const r = parseValue(buf, o, maxBulk);
    a[i] = r.value;
    o = r.offset;
  }
  return { value: { t: kind, a }, offset: o };
}

// Flatten any parsed RESP value to a bulk-string Buffer for argv purposes
// (so commands sent with RESP3 types still work).
function flattenArg(v) {
  if (!v) return Buffer.alloc(0);
  if (v.t === '$') return v.b === null ? Buffer.alloc(0) : Buffer.from(v.b);
  if (v.t === '+') return Buffer.from(v.s, 'utf8');
  if (v.t === '-') return Buffer.from(v.s, 'utf8');
  if (v.t === ':') return Buffer.from(String(v.n), 'latin1');
  if (v.t === '#') return Buffer.from(v.b ? '1' : '0', 'latin1');
  if (v.t === ',') return Buffer.from(String(v.d), 'latin1');
  if (v.t === '_') return Buffer.alloc(0);
  if (v.t === '=') return Buffer.from(v.b);
  if (v.t === '(') return Buffer.from(v.s, 'latin1');
  if (v.t === '!') return Buffer.from(v.s, 'utf8');
  if (v.t === '*' || v.t === '~' || v.t === '>') {
    if (!v.a) return Buffer.alloc(0);
    return Buffer.from(v.a.map((x) => flattenArg(x).toString('latin1')).join(' '), 'latin1');
  }
  if (v.t === '%') {
    if (!v.a) return Buffer.alloc(0);
    const out = [];
    for (let i = 0; i + 1 < v.a.length; i += 2) out.push(flattenArg(v.a[i]).toString('latin1') + '=' + flattenArg(v.a[i + 1]).toString('latin1'));
    return Buffer.from(out.join(' '), 'latin1');
  }
  if (v.t === '|') {
    if (!v.a || !v.a.length) return Buffer.alloc(0);
    return flattenArg(v.a[v.a.length - 1]);
  }
  return Buffer.alloc(0);
}
// ---------------------------------------------------------------------
// Inline (telnet-style) protocol: `SET k v\r\n` or `PING\r\n`.
// Tokenizes honouring "double" / 'single' quotes and \xNN escapes.
// ---------------------------------------------------------------------

function parseInline(lineBuf) {
  const s = lineBuf.toString('utf8');
  const argv = [];
  let i = 0;
  let pending = null;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (pending !== null) { argv.push(Buffer.from(pending, 'utf8')); pending = null; }
      i++;
      continue;
    }
    if (pending === null) pending = '';
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      let acc = '';
      let closed = false;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '\\' && i + 1 < s.length) {
          const esc = s[i + 1];
          if (esc === 'x' && i + 3 < s.length) {
            const hx = s.slice(i + 2, i + 4);
            if (/^[0-9a-fA-F]{2}$/.test(hx)) { acc += String.fromCharCode(parseInt(hx, 16)); i += 4; continue; }
          }
          acc += esc; i += 2; continue;
        }
        if (ch === q) { closed = true; i++; break; }
        acc += ch; i++;
      }
      if (!closed) throw new Incomplete();
      pending += acc;
      continue;
    }
    if (c === '\\' && i + 1 < s.length) {
      const esc = s[i + 1];
      if (esc === 'x' && i + 3 < s.length) {
        const hx = s.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hx)) { pending += String.fromCharCode(parseInt(hx, 16)); i += 4; continue; }
      }
      pending += esc; i += 2; continue;
    }
    pending += c;
    i++;
  }
  if (pending !== null) argv.push(Buffer.from(pending, 'utf8'));
  return argv;
}

// ---------------------------------------------------------------------
// RespParser — buffer fed, yields complete values on demand.
// ---------------------------------------------------------------------

const MAX_BULK = 512 * 1024 * 1024;

class RespParser {
  constructor({ maxBulk = MAX_BULK } = {}) {
    this.buf = Buffer.alloc(0);
    this.maxBulk = maxBulk;
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
  }

  // Parse out every complete value currently buffered. On protocol errors,
  // throws ProtocolError and resets the buffer (connection will be closed).
  parse() {
    const out = [];
    let buf = this.buf;
    while (buf.length > 0) {
      const type = buf[0];
      let res;
      try {
        if (type === 0x2a || type === 0x24 || type === 0x2b || type === 0x2d || type === 0x3a ||
            type === 0x25 || type === 0x7e || type === 0x3e || type === 0x7c || type === 0x23 ||
            type === 0x2c || type === 0x5f || type === 0x3d || type === 0x21 || type === 0x28) {
          res = parseValue(buf, 0, this.maxBulk);
        } else {
          const line = readLine(buf, 0);
          if (line === null) break;
          const argv = parseInline(line.line);
          if (argv.length === 0) { buf = buf.subarray(line.end); continue; }
          out.push({ t: '*', a: argv.map((b) => ({ t: '$', b })) });
          buf = buf.subarray(line.end);
          continue;
        }
      } catch (e) {
        if (e.xrIncomplete) break;
        this.buf = Buffer.alloc(0);
        throw e;
      }
      out.push(res.value);
      buf = buf.subarray(res.offset);
    }
    this.buf = buf;
    return out;
  }
}

module.exports = {
  CRLF, encSimple, encError, encInt, encNull, encNullArray, encBulk, encArr,
  encCmd, encErrLike, encNull3, encBool, encDouble, encVerbatim, encMap, encSet, encPush,
  flattenArg,
  ProtocolError, RespParser, parseValue, MAX_BULK,
};
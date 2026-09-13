'use strict';

const crypto = require('crypto');

class CommandError extends Error {
  constructor(msg, code) {
    super(msg);
    this.name = 'CommandError';
    this.xrCommand = true;
    this.xrCode = code || 'ERR';
  }
}

class WrongTypeError extends CommandError {
  constructor() {
    super('WRONGTYPE Operation against a key holding the wrong kind of value');
    this.name = 'WrongTypeError';
    this.xrCode = 'WRONGTYPE';
  }
}

function wrongType() { return new WrongTypeError(); }
function arity(cmd) { return new CommandError(`wrong number of arguments for '${cmd}' command`); }
function err(msg) { return new CommandError(msg); }
function notInt() { return new CommandError('value is not an integer or out of range'); }
function notFloat() { return new CommandError('value is not a valid float'); }

// Keys/fields/members are stored as latin1 strings: latin1 maps bytes 0-255 to
// code units 0-255 1:1, so binary keys are preserved and JS string < compares
// byte-exactly.
function toStr(buf) { return Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf); }
function toBuf(str) { return Buffer.isBuffer(str) ? str : Buffer.from(str, 'latin1'); }

function parseIntArg(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  if (!/^-?\d+$/.test(s)) throw notInt();
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw notInt();
  return n;
}

function parseFloatArg(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) throw notFloat();
  const n = Number(s);
  if (!Number.isFinite(n)) throw notFloat();
  return n;
}

function formatDouble(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e17) return String(n);
  return String(n);
}

function normIndex(i, len) { return i < 0 ? len + i : i; }

// Inclusive [start, stop] range per Redis index semantics (negative allowed).
function computeRange(startBuf, stopBuf, len) {
  if (len === 0) return [0, -1];
  let s = normIndex(parseIntArg(startBuf), len);
  let e = normIndex(parseIntArg(stopBuf), len);
  if (s < 0) s = 0;
  if (e >= len) e = len - 1;
  return [s, e];
}

function parseScoreBound(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  if (s === '-inf') return { value: -Infinity, exclusive: false };
  if (s === '+inf') return { value: Infinity, exclusive: false };
  let exclusive = false;
  let num = s;
  if (num.startsWith('(')) { exclusive = true; num = num.slice(1); }
  if (/^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(num)) {
    return { value: Number(num), exclusive };
  }
  throw notFloat();
}

function parseLexBound(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
  if (s === '-') return { dir: -1 };
  if (s === '+') return { dir: 1 };
  let exclusive = false;
  let val = s;
  if (val.startsWith('(')) { exclusive = true; val = val.slice(1); }
  else if (val.startsWith('[')) { val = val.slice(1); }
  else throw err('min or max not valid string range item');
  return { value: val, exclusive, dir: 0 };
}

/* ------------ Redis glob patterns: * ? [...] ------------ */

function matchClass(p, i, ch) {
  let j = i + 1;
  let neg = false;
  if (p[j] === '^') { neg = true; j++; }
  let matched = false;
  let first = true;
  while (j < p.length) {
    if (p[j] === ']' && !first) break;
    first = false;
    if (p[j] === '\\' && j + 1 < p.length) {
      if (p[j + 1] === ch) matched = true;
      j += 2;
      continue;
    }
    if (j + 2 < p.length && p[j + 1] === '-' && p[j + 2] !== ']') {
      if (ch >= p[j] && ch <= p[j + 2]) matched = true;
      j += 3;
      continue;
    }
    if (p[j] === ch) matched = true;
    j++;
  }
  if (j >= p.length) return null;
  return { res: neg ? !matched : matched, next: j + 1 };
}

function globMatch(pattern, str) {
  let pi = 0, si = 0;
  let starIdx = -1, starStrIdx = 0;
  while (si < str.length) {
    if (pi < pattern.length) {
      const c = pattern[pi];
      if (c === '*') {
        starIdx = pi; starStrIdx = si; pi++;
        continue;
      } else if (c === '?') { pi++; si++; continue; }
      else if (c === '[') {
        const cls = matchClass(pattern, pi, str[si]);
        if (cls) { if (cls.res) { pi = cls.next; si++; continue; } }
        else if (str[si] === '[') { pi++; si++; continue; }
      } else if (c === str[si]) { pi++; si++; continue; }
    }
    if (starIdx === -1) return false;
    pi = starIdx + 1;
    si = ++starStrIdx;
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

/* ---------------- misc ---------------- */

function randomHex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }

function timeMs() { return Date.now(); }

module.exports = {
  CommandError, WrongTypeError, wrongType, arity, err, notInt, notFloat,
  toStr, toBuf, parseIntArg, parseFloatArg, formatDouble, normIndex, computeRange,
  parseScoreBound, parseLexBound, globMatch, randomHex, timeMs,
};
'use strict';

// Reply context helpers passed to every command handler. Handlers return the
// encoded reply Buffer (or throw a CommandError / WrongTypeError).
//
// The ctx is protocol-aware: after `HELLO 3` the connection speaks RESP3, so
// nil becomes the typed null `_\r\n` and booleans/doubles use `#` / `,`.

const P = require('../protocol');

function makeCtx(client) {
  const isResp3 = () => !!(client && client.resp === 3);
  return {
    ok: () => P.encSimple('OK'),
    status: (s) => P.encSimple(s),
    err: (s) => P.encError(s),
    int: (n) => P.encInt(n),
    nil: () => (isResp3() ? P.encNull3() : P.encNull()),
    nilArr: () => (isResp3() ? P.encNull3() : P.encNullArray()),
    bulk: (b) => {
      if (b === null || b === undefined) return isResp3() ? P.encNull3() : P.encNull();
      return P.encBulk(b);
    },
    arr: (parts) => P.encArr(parts),
    bool: (b) => (isResp3() ? P.encBool(!!b) : P.encInt(b ? 1 : 0)),
    double: (n) => (isResp3() ? P.encDouble(n) : P.encBulk(Buffer.from(String(n), 'latin1'))),
    map: (pairs) => (isResp3() ? P.encMap(pairs) : P.encArr(pairs)),
    set: (parts) => (isResp3() ? P.encSet(parts) : P.encArr(parts)),
    verbatim: (fmt, data) => (isResp3() ? P.encVerbatim(fmt, data) : P.encBulk(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'))),
    push: (parts) => P.encPush(parts),
  };
}

module.exports = { makeCtx };

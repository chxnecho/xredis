'use strict';

// Transactions: MULTI, EXEC, DISCARD, WATCH, UNWATCH.
//
// Semantics: WATCH registers keys against this client. If any watched key is
// touched (modified/removed/expired) between WATCH and EXEC, EXEC aborts with
// -EXECABORT. All commands received while in MULTI are queued and answered
// +QUEUED; EXEC runs them atomically (we are single-threaded, so atomic is
// natural) and returns their replies as one array.

const { toStr, err } = require('../util');
const P = require('../protocol');

function touchKey(server, dbIdx, key) {
  const watchers = server.watchedKeys.get(key);
  if (!watchers) return;
  for (const client of watchers) {
    client.watchedDirty = true;
  }
  // Keep the entry alive until EXEC checks it, or remove it — safe to leave.
}

// Wire: call rb.touch? we handle via db mutation hooks.
// The dispatcher calls server.touchKeys(dbIdx, keys) after any command that
// modified keys.

function cmdMulti(server, argv, ctx, client) {
  if (client.inMulti) throw err('ERR MULTI calls can not be nested');
  client.inMulti = true;
  client.multiQueue = [];
  return ctx.status('OK');
}

function cmdDiscard(server, argv, ctx, client) {
  if (!client.inMulti) throw err('ERR DISCARD without MULTI');
  client.inMulti = false;
  client.multiQueue = null;
  client.watched = null;
  client.watchedDirty = false;
  return ctx.ok();
}

function cmdExec(server, argv, ctx, client) {
  if (!client.inMulti) throw err('ERR EXEC without MULTI');
  const queue = client.multiQueue;
  client.inMulti = false;
  client.multiQueue = null;
  // WATCH check
  if (client.watchedDirty) {
    client.watched = null;
    client.watchedDirty = false;
    return ctx.errLike('EXECABORT Transaction discarded because of previous errors.');
  }
  return server.execQueue(client, queue);
}

function cmdWatch(server, argv, ctx, client) {
  if (client.inMulti) throw err('ERR WATCH inside MULTI is not allowed');
  if (!client.watched) client.watched = new Set();
  for (let i = 1; i < argv.length; i++) {
    const key = toStr(argv[i]);
    if (client.watched.has(key)) continue;
    client.watched.add(key);
    if (!server.watchedKeys.has(key)) server.watchedKeys.set(key, new Set());
    server.watchedKeys.get(key).add(client);
  }
  return ctx.ok();
}

function cmdUnwatch(server, argv, ctx, client) {
  if (client.watched) {
    for (const key of client.watched) {
      const set = server.watchedKeys.get(key);
      if (set) { set.delete(client); if (set.size === 0) server.watchedKeys.delete(key); }
    }
    client.watched = null;
  }
  client.watchedDirty = false;
  return ctx.ok();
}

module.exports = { cmdMulti, cmdDiscard, cmdExec, cmdWatch, cmdUnwatch, touchKey };
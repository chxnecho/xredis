'use strict';

// Admin & introspection commands: SAVE, BGSAVE, SHUTDOWN, DEBUG, MEMORY,
// OBJECT, ROLE, SLOWLOG, DBSIZE (already in keyspace), LASTSAVE, CONFIG.

const { toStr, err } = require('../util');
const P = require('../protocol');

function cmdSave(server, argv, ctx) {
  server.rdbSave('save');
  return ctx.ok();
}

function cmdBgSave(server, argv, ctx) {
  setImmediate(() => {
    try {
      server.rdbSave('bgsave');
    } catch (e) {
      server.log('warning', 'BGSAVE failed: ' + e.message);
      server.lastBgsaveStatus = 'err: ' + e.message;
    }
  });
  return ctx.status('Background saving started');
}

function cmdShutdown(server, argv, ctx) {
  server.gracefulShutdown('shutdown');
  return ctx.status('OK');
}

function cmdDebug(server, argv, ctx) {
  const sub = toStr(argv[1]).toUpperCase();
  if (sub === 'SLEEP') {
    const s = Buffer.isBuffer(argv[2]) ? argv[2].toString('latin1') : String(argv[2]);
    const secs = Number(s);
    const start = Date.now();
    const ms = secs * 1000;
    while (Date.now() - start < ms) { /* busy-wait like real DEBUG SLEEP */ }
    return ctx.ok();
  }
  if (sub === 'OBJECT') return ctx.status('Value at:0x0 refcount:1 encoding:raw serializedlength:0');
  if (sub === 'JMAP') return ctx.ok();
  if (sub === 'QUICKLIST-PACKED-THRESHOLD') return ctx.int(0);
  if (sub === 'SET-ACTIVE-EXPIRE') return ctx.ok();
  if (sub === 'CHANGE-REPL-ID') return ctx.ok();
  throw err('ERR DEBUG subcommand not supported');
}

function estimateSize(obj) {
  switch (obj.type) {
    case 'string': return 16 + obj.buf.length;
    case 'list': return 16 + obj.list.length * 40;
    case 'hash': return 16 + obj.map.size * 64;
    case 'set': return 16 + obj.length * 32;
    case 'zset': return 16 + obj.length * 96;
    default: return 16;
  }
}

function cmdMemory(server, argv, ctx) {
  const sub = toStr(argv[1]).toUpperCase();
  if (sub === 'USAGE') {
    const obj = server.db.lookup(toStr(argv[2]));
    return ctx.int(obj ? estimateSize(obj) : 0);
  }
  if (sub === 'STATS') return ctx.arr([]);
  if (sub === 'DOCTOR') return ctx.bulk(Buffer.from('Sam, I detected a few issues in this Redis instance memory implants:\n\n * Everything looks good.\n', 'latin1'));
  if (sub === 'PURGE') return ctx.ok();
  throw err('ERR unknown subcommand');
}

function cmdObject(server, argv, ctx) {
  const sub = toStr(argv[1]).toUpperCase();
  const obj = server.db.lookup(toStr(argv[2]));
  if (sub === 'ENCODING') {
    if (!obj) return ctx.nil();
    let enc = 'raw';
    if (obj.type === 'string') enc = obj.int !== null ? 'int' : (obj.buf.length < 44 ? 'embstr' : 'raw');
    if (obj.type === 'list') enc = 'linkedlist';
    if (obj.type === 'hash') enc = 'hashtable';
    if (obj.type === 'set') enc = obj.map ? 'hashtable' : 'intset';
    if (obj.type === 'zset') enc = 'skiplist';
    return ctx.status(enc);
  }
  if (sub === 'REFCOUNT') return ctx.int(obj ? 1 : 0);
  if (sub === 'IDLETIME') return ctx.int(obj ? Math.floor((Date.now() - obj.idletime) / 1000) : -1);
  if (sub === 'FREQ') return ctx.int(obj ? (obj.freq || 1) : 0);
  if (sub === 'HELP') return ctx.bulk(Buffer.from('OBJECT <subcommand> ...', 'latin1'));
  throw err('ERR unknown subcommand');
}

function cmdRole(server, argv, ctx) {
  if (server.role === 'master') {
    return ctx.arr([P.encBulk(Buffer.from('master', 'latin1')), P.encInt(0)]);
  }
  return ctx.arr([
    P.encBulk(Buffer.from('slave', 'latin1')),
    P.encBulk(Buffer.from(String(server.config.replicaof.host), 'latin1')),
    P.encInt(server.config.replicaof.port),
    P.encBulk(Buffer.from(server.masterLinkState || 'down', 'latin1')),
    P.encInt(server.masterOffset || 0),
  ]);
}

function cmdSlowlog(server, argv, ctx) {
  const sub = toStr(argv[1]).toUpperCase();
  if (sub === 'LEN') return ctx.int(0);
  if (sub === 'GET') return ctx.arr([]);
  if (sub === 'RESET') return ctx.ok();
  if (sub === 'HELP') return ctx.bulk(Buffer.from('SLOWLOG <subcommand> ...', 'latin1'));
  throw err('ERR unknown subcommand');
}

// REPLICAOF host port | REPLICAOF NO ONE
function cmdReplicaOf(server, argv, ctx) {
  const host = toStr(argv[1]).toLowerCase();
  if (server.role === 'replica' && host === 'no' && toStr(argv[2]).toUpperCase() === 'ONE') {
    server.stopReplication();
    return ctx.ok();
  }
  if (host === 'no' && toStr(argv[2]).toUpperCase() === 'ONE') {
    server.stopReplication('master');
    return ctx.ok();
  }
  const port = Number(toStr(argv[2]));
  server.startReplication(host, port);
  return ctx.status('OK');
}

// Internal sync handshake used by xredis replicas.
function cmdXReplSync(server, argv, ctx, client) {
  const { NO_REPLY } = require('../server');
  const rlink = {
    socket: client.socket,
    host: client.socket.remoteAddress || 'unknown',
    port: client.socket.remotePort || 0,
    online: false,
  };
  server.handleSyncRequest(rlink);
  return NO_REPLY;
}

// PSYNC <replid> <offset> — full Redis handshake with partial resync support.
function cmdPsync(server, argv, ctx, client) {
  const { NO_REPLY } = require('../server');
  const rlink = {
    socket: client.socket,
    host: client.socket.remoteAddress || 'unknown',
    port: client.socket.remotePort || 0,
    online: false,
  };
  const replid = toStr(argv[1]);
  const offset = Number(toStr(argv[2]));
  if (!Number.isFinite(offset)) throw err('value is not an integer or out of range');
  server.handlePsyncRequest(rlink, replid, offset);
  return NO_REPLY;
}

// REPLCONF: replica handshake parameters and offset ACKs from the replica
// back to the master.
function cmdReplConf(server, argv, ctx, client) {
  const opt = toStr(argv[1]).toLowerCase();
  if (opt === 'listening-port' || opt === 'capa' || opt === 'capa2') {
    const r = server.replicas.find((x) => x.socket === client.socket);
    if (r && opt === 'listening-port') r.listenPort = Number(toStr(argv[2])) || 0;
    return ctx.ok();
  }
  if (opt === 'ack') {
    // Replica → master: this is how the master learns replica progress.
    const offset = Number(toStr(argv[2]));
    const r = server.replicas.find((x) => x.socket === client.socket);
    if (r) r.acked = offset;
    return null; // no reply to the replica
  }
  if (opt === 'getack') {
    // Master → replica request should never land here; replicas intercept it
    // in the replication link reader. Ignore politely.
    return ctx.ok();
  }
  throw err('ERR Unrecognized REPLCONF option: ' + toStr(argv[1]));
}

// WAIT <numreplicas> <timeout-ms>: block until the replicas have ACKed the
// current replication offset (or the timeout expires).
function cmdWait(server, argv, ctx, client) {
  const { parseIntArg } = require('../util');
  const num = parseIntArg(argv[1]);
  const timeout = parseIntArg(argv[2]);
  if (num < 0 || timeout < 0) throw err('value is not an integer or out of range');
  const ackedNow = server.replicas.filter((r) => r.acked !== undefined && r.acked >= server.replOffset).length;
  if (ackedNow >= num || timeout === 0) return ctx.int(ackedNow);

  const deadline = Date.now() + timeout;
  const target = server.replOffset;
  const poll = () => {
    if (!client.socket || !client.socket.writable) return;
    const acked = server.replicas.filter((r) => r.acked !== undefined && r.acked >= target).length;
    if (acked >= num || Date.now() >= deadline) {
      client.socket.write(P.encInt(acked));
      return;
    }
    setTimeout(poll, 5);
  };
  poll();
  return require('../server').NO_REPLY;
}

module.exports = {
  cmdSave, cmdBgSave, cmdShutdown, cmdDebug, cmdMemory, cmdObject, cmdRole, cmdSlowlog,
  cmdReplicaOf, cmdXReplSync, cmdPsync, cmdReplConf, cmdWait,
};
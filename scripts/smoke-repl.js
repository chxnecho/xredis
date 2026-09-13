'use strict';

// Replication test: master + replica over TCP. Verifies the full sync
// snapshot replay and the subsequent incremental command propagation.

const { spawn } = require('child_process');
const { Client } = require('../src/client');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT_M = 9401 + Math.floor(Math.random() * 100);
const PORT_R = PORT_M + 1;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xredis-repl-'));

function start(port, extra = []) {
  const s = spawn('node', [
    path.join(__dirname, '../bin/xredis-server.js'),
    '--port', String(port), '--dir', DIR,
  ].concat(extra), { stdio: ['ignore', 'pipe', 'pipe'] });
  s.log = '';
  s.stdout.on('data', (d) => { s.log += d; });
  s.stderr.on('data', (d) => { s.log += d; });
  return s;
}

function waitPort(port, ms = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const try_ = () => {
      const c = new Client({ port });
      c.connect().then(() => { c.close(); resolve(); }).catch(() => {
        if (Date.now() - start > ms) reject(new Error('no server on ' + port));
        else setTimeout(try_, 100);
      });
    };
    try_();
  });
}

const b = (x) => (Buffer.isBuffer(x) ? x.toString('utf8') : x);

function assert(cond, label, ...srvs) {
  if (!cond) {
    console.error('FAIL ' + label);
    for (const s of srvs) console.error('--- log ---\n' + s.log);
    for (const s of srvs) if (s.kill) s.kill('SIGKILL');
    process.exit(1);
  }
}

async function main(master) {
  const cm = new Client({ port: PORT_M });
  await cm.connect();

  // Seed data before the replica joins.
  await cm.send(['SET', 'mk1', 'mv1']);
  await cm.send(['RPUSH', 'mlist', 'x', 'y']);
  await cm.send(['HSET', 'mhash', 'f', 'v']);
  await cm.send(['ZADD', 'mz', '5', 'e']);

  const replica = start(PORT_R, ['--replicaof', '127.0.0.1', String(PORT_M), '--dir', DIR + '-repl']);

  await waitPort(PORT_R);
  await new Promise((r) => setTimeout(r, 600));

  // Full sync verification.
  const cr = new Client({ port: PORT_R });
  await cr.connect();
  assert(b(await cr.send(['GET', 'mk1'])) === 'mv1', 'full sync: string', master, replica);
  const lst = (await cr.send(['LRANGE', 'mlist', '0', '-1'])).map(b);
  assert(lst.join(',') === 'x,y', 'full sync: list', master, replica);
  assert(b(await cr.send(['HGET', 'mhash', 'f'])) === 'v', 'full sync: hash', master, replica);
  const z = (await cr.send(['ZRANGE', 'mz', '0', '-1'])).map(b);
  assert(z.join(',') === 'e', 'full sync: zset', master, replica);

  // Replica is read-only.
  let ro = false;
  try { await cr.send(['SET', 'mk1', 'nope']); } catch (e) { ro = e.message.startsWith('READONLY'); }
  assert(ro, 'replica rejects writes', master, replica);

  // Incremental propagation.
  await cm.send(['SET', 'mk2', 'live1']);
  await cm.send(['INCR', 'mctr']);
  await cm.send(['DEL', 'mk1']);
  await cm.send(['SET', 'ttlkey', 'v', 'EX', '100']);
  await new Promise((r) => setTimeout(r, 200));

  assert(b(await cr.send(['GET', 'mk2'])) === 'live1', 'incremental: SET, got ' + JSON.stringify(await cr.send(['GET', 'mk2'])), master, replica);
  assert(Number(await cr.send(['GET', 'mctr'])) === 1, 'incremental: INCR', master, replica);
  assert(await cr.send(['EXISTS', 'mk1']) === 0, 'incremental: DEL', master, replica);

  // TTL survived propagation.
  const ttl = await cr.send(['TTL', 'ttlkey']);
  assert(ttl > 80 && ttl <= 100, 'incremental: TTL, got ' + ttl, master, replica);

  // Failed conditional writes must not propagate: canonicalize() strips
  // NX/XX, so a propagated `SET k new NX` that failed would become a plain
  // `SET k new` on the replica and change its value.
  await cm.send(['SET', 'cond', 'old']);
  await cm.send(['SET', 'cond', 'new', 'NX']);
  await new Promise((r) => setTimeout(r, 200));
  assert(b(await cr.send(['GET', 'cond'])) === 'old',
    'failed SET NX not propagated, replica got: ' + JSON.stringify(await cr.send(['GET', 'cond'])), master, replica);

  // SPOP picks members randomly, so replaying the command itself on a replica
  // would pop different members. The replica must converge on the propagated
  // deterministic SREM effect instead.
  await cm.send(['SADD', 'srand', 'a', 'b', 'c', 'd']);
  const popped = (await cm.send(['SPOP', 'srand', '2'])).map(b);
  await new Promise((r) => setTimeout(r, 200));
  assert(popped.length === 2, 'SPOP popped 2, got ' + popped.length, master, replica);
  const mRem = (await cm.send(['SMEMBERS', 'srand'])).map(b).sort().join(',');
  const rRem = (await cr.send(['SMEMBERS', 'srand'])).map(b).sort().join(',');
  assert(mRem === rRem, 'SPOP replica convergence: master=' + mRem + ' replica=' + rRem, master, replica);
  assert(await cr.send(['SCARD', 'srand']) === 2, 'SPOP replica card', master, replica);

  // ROLE reporting.
  assert(b((await cm.send(['ROLE']))[0]) === 'master', 'master role', master, replica);
  assert(b((await cr.send(['ROLE']))[0]) === 'slave', 'replica role', master, replica);

  console.log('REPLICATION TESTS PASSED');

  // ---- partial resync + WAIT (raw-socket fake replica) ----
  await partialResyncTest(cm, PORT_M, master, replica);

  cm.close(); cr.close();
  replica.kill('SIGKILL');
  master.kill('SIGTERM');
  setTimeout(() => process.exit(0), 200);
}

// A raw TCP socket acting as a replica, so we can observe FULLRESYNC /
// CONTINUE and validate the backlog-based partial resync path.
async function partialResyncTest(cm, port, master, replica) {
  const net = require('net');
  const { RespParser, encCmd } = require('../src/protocol');

  let masterReplid = null;
  let offset = 0;
  const parser = new RespParser();
  const frames = [];   // command frames received after handshake
  const status = { phase: 'handshake', fullSync: false, contSync: false };

  const sock = net.createConnection({ host: '127.0.0.1', port });
  sock.setNoDelay(true);
  await new Promise((resolve, reject) => { sock.on('connect', resolve); sock.on('error', reject); });

  sock.on('data', (chunk) => {
    parser.feed(chunk);
    let vals;
    try { vals = parser.parse(); } catch (e) { return; }
    for (const v of vals) {
      if (v.t === '+') {
        if (v.s.startsWith('FULLRESYNC')) {
          status.fullSync = true;
          const parts = v.s.split(/\s+/);
          masterReplid = parts[1];
          offset = Number(parts[2]) || 0;
          status.phase = 'snapshot';
        } else if (v.s.startsWith('CONTINUE')) {
          status.contSync = true;
          status.phase = 'stream';
        }
        continue;
      }
      if (v.t === '$' && status.phase === 'snapshot') {
        status.phase = 'stream';
        // Snapshot payload is a RESP command stream; its bytes are *not* part
        // of the backlog offsets, same as real Redis (RDB flow).
        continue;
      }
      if (v.t === '*' && status.phase === 'stream') {
        if (!v.a) continue;
        const argv = v.a.map((x) => x && x.b).filter((b) => Buffer.isBuffer(b));
        if (!argv.length) continue;
        const name = argv[0] ? argv[0].toString('latin1').toLowerCase() : '';
        if (name === 'replconf') continue; // GETACK heartbeat is not in the stream
        offset += encCmd(argv).length;
        frames.push(argv.map((x) => x.toString('latin1')).join(' '));
      }
    }
  });

  // Handshake.
  sock.write(encCmd(['REPLCONF', 'listening-port', '0']));
  sock.write(encCmd(['REPLCONF', 'capa', 'psync2']));
  sock.write(encCmd(['PSYNC', '?', '-1']));
  await new Promise((r) => setTimeout(r, 400));
  assert(status.fullSync, 'fake replica: received FULLRESYNC', master);

  // Real replica still connected too: two replicas now.
  await cm.send(['SET', 'pr1', 'before-disconnect']);
  await new Promise((r) => setTimeout(r, 200));
  const before = frames.some((f) => f.startsWith('SET pr1'));
  assert(before, 'fake replica: got incremental SET', master);

  // Disconnect, then more writes happen (must accumulate in the backlog).
  sock.destroy();
  await new Promise((r) => setTimeout(r, 100));
  await cm.send(['SET', 'pr2', 'while-disconnected']);
  await cm.send(['INCR', 'prctr']);
  await new Promise((r) => setTimeout(r, 200));

  // Reconnect with the remembered replid+offset → expect CONTINUE and replay.
  const parser2 = new RespParser();
  let contSync = false;
  const replayed = [];
  const sock2 = net.createConnection({ host: '127.0.0.1', port });
  sock2.setNoDelay(true);
  await new Promise((resolve) => sock2.on('connect', resolve));
  sock2.on('data', (chunk) => {
    parser2.feed(chunk);
    let vals;
    try { vals = parser2.parse(); } catch (e) { return; }
    for (const v of vals) {
      if (v.t === '+' && v.s.startsWith('CONTINUE')) contSync = true;
      if (v.t === '*' && contSync) {
        if (!v.a) continue;
        const argv = v.a.map((x) => x && x.b).filter((b) => Buffer.isBuffer(b));
        if (!argv.length) continue;
        if (argv[0].toString('latin1').toLowerCase() === 'replconf') continue;
        replayed.push(argv.map((x) => x.toString('latin1')).join(' '));
      }
    }
  });
  sock2.write(encCmd(['REPLCONF', 'capa', 'psync2']));
  sock2.write(encCmd(['PSYNC', masterReplid, String(offset)]));
  await new Promise((r) => setTimeout(r, 400));
  assert(contSync, 'fake replica 2: expected +CONTINUE (partial resync)', master);
  assert(replayed.some((f) => f.startsWith('SET pr2')), 'partial resync: SET pr2 replayed', master);
  assert(replayed.some((f) => f.startsWith('INCR prctr')), 'partial resync: INCR replayed', master);
  sock2.destroy();

  // WAIT: the real replica ACKs offsets; ask for 1 replica with a 2s budget.
  await new Promise((r) => setTimeout(r, 1500)); // let a heartbeat ACK cycle run
  const acked = await cm.send(['WAIT', '1', '2000']);
  assert(typeof acked === 'number' && acked >= 1, 'WAIT returned ' + JSON.stringify(acked) + ' (>=1 replica ACKed)', master);

  console.log('PARTIAL RESYNC + WAIT TESTS PASSED');
}

async function run() {
  const master = start(PORT_M);
  await waitPort(PORT_M);
  await main(master);
}

run().catch((e) => {
  console.error('REPL TEST FAILED: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
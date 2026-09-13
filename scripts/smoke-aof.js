'use strict';

// Persistence test: write data, SIGKILL the server (simulated crash), restart,
// and verify the AOF replay restored everything.

const { spawn } = require('child_process');
const { Client } = require('../src/client');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT1 = 8801 + Math.floor(Math.random() * 100);
const PORT2 = PORT1 + 1;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xredis-aof-'));

function start(port) {
  const s = spawn('node', [
    path.join(__dirname, '../bin/xredis-server.js'),
    '--port', String(port), '--dir', DIR, '--appendonly', 'yes', '--appendfsync', 'always',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
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

async function main() {
  // --- phase 1: seed data ---
  let srv = start(PORT1);
  await waitPort(PORT1);
  let c = new Client({ port: PORT1 });
  await c.connect();
  await c.send(['SET', 'str', 'hello']);
  await c.send(['RPUSH', 'lst', 'a', 'b', 'c']);
  await c.send(['HSET', 'hsh', 'f1', 'v1']);
  await c.send(['SADD', 'set', 'm1', 'm2']);
  await c.send(['ZADD', 'zs', '1', 'a', '2', 'b']);
  await c.send(['SET', 'volatile', 'v', 'EX', '100']);
  // Conditional write that fails must never reach the AOF, otherwise a bare
  // SET replay would resurrect the value after a crash.
  await c.send(['SET', 'condkey', 'old']);
  await c.send(['SET', 'condkey', 'new', 'NX']);
  const foobar = await c.send(['GET', 'str']);
  console.log('seeded:' , b(foobar));
  c.close();

  // Crash with SIGKILL (no graceful shutdown).
  srv.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  console.log('crashed server, AOF file:', fs.existsSync(path.join(DIR, 'appendonly.aof')));

  // --- phase 2: restart & verify ---
  srv = start(PORT2);
  await waitPort(PORT2, 7000);
  c = new Client({ port: PORT2 });
  await c.connect();
  const checks = [
    ['str', 'hello'], ['lst:a', 'a'], ['hsh.f1', 'v1'],
    ['zs:a', '1'], ['volatile', 'v'],
  ];
  const r1 = b(await c.send(['GET', 'str']));
  assert(r1 === 'hello', 'GET str after restore', srv);
  const lst = (await c.send(['LRANGE', 'lst', '0', '-1'])).map(b);
  assert(lst.join(',') === 'a,b,c', 'LRANGE after restore', srv);
  const hsh = (await c.send(['HGET', 'hsh', 'f1']));
  assert(b(hsh) === 'v1', 'HGET after restore', srv);
  const z = (await c.send(['ZRANGE', 'zs', '0', '-1'])).map(b);
  assert(z.join(',') === 'a,b', 'ZRANGE after restore', srv);
  const ttl = await c.send(['TTL', 'volatile']);
  assert(ttl > 80 && ttl <= 100, 'TTL preserved: ' + ttl, srv);

  // The failed `SET condkey new NX` must not be in the AOF: the key must
  // still hold 'old' after the crash replay.
  assert(b(await c.send(['GET', 'condkey'])) === 'old', 'failed SET NX not persisted, got: ' + JSON.stringify(await c.send(['GET', 'condkey'])), srv);

  // set key with NX shouldn't resurrect; check unlink
  const del = await c.send(['DEL', 'set']);
  const after = await c.send(['EXISTS', 'set']);
  assert(del === 1 && after === 0, 'DEL/EXISTS', srv);

  console.log('AOF PERSISTENCE TESTS PASSED');
  c.close();
  srv.kill('SIGTERM');
  setTimeout(() => process.exit(0), 200);
}

function assert(cond, label, srv) {
  if (!cond) {
    console.error('FAIL ' + label);
    console.error(srv.log);
    srv.kill('SIGKILL');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('AOF TEST FAILED: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
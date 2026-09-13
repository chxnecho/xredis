'use strict';

// RDB persistence tests:
//  1. In-process roundtrip: serialize a populated keyspace, deserialize into
//     a fresh server, compare values + CRC rejection of corrupted files.
//  2. Subprocess crash recovery: write data with AOF off, SIGKILL, restart,
//     verify data came back from the RDB file.

const { spawn } = require('child_process');
const { Client } = require('../src/client');
const { RedisServer } = require('../src/server');
const { configure } = require('../src/config');
const rdb = require('../src/persistence/rdb');
const path = require('path');
const fs = require('fs');
const os = require('os');

const b = (x) => (Buffer.isBuffer(x) ? x.toString('utf8') : x);

function fail(msg, extra) {
  console.error('FAIL ' + msg);
  if (extra) console.error(extra);
  process.exit(1);
}

/* ------------------------------ part 1 ------------------------------ */

function part1() {
  const cfg = configure(['--port', '0', '--dir', '/tmp/xredis-rdb-inproc-' + Date.now()], {}).cfg;
  const s1 = new RedisServer(cfg, { logger: () => {} });
  s1.execRaw(['SET', 'str', 'hello']);
  s1.execRaw(['SET', 'intkey', '42']);
  s1.execRaw(['RPUSH', 'lst', 'a', 'b', 'c']);
  s1.execRaw(['HSET', 'hsh', 'f1', 'v1', 'f2', 'v2']);
  s1.execRaw(['SADD', 'ints', '1', '2', '3']);           // intset encoding
  s1.execRaw(['SADD', 'strs', 'x', 'y', 'z']);           // hashtable encoding
  s1.execRaw(['ZADD', 'zs', '1.5', 'a', '2.5', 'b']);
  s1.execRaw(['SET', 'tmp', 'v', 'PX', '60000']);        // with TTL
  s1.execRaw(['SELECT', '3']);
  s1.execRaw(['SET', 'otherdb', 'yes']);
  s1.execRaw(['SELECT', '0']);

  const blob = rdb.serialize(s1);

  const s2 = new RedisServer(cfg, { logger: () => {} });
  const count = rdb.deserialize(s2, blob);

  const checks = [
    [b(s2.db.lookup('str').buf) === 'hello', 'string roundtrip'],
    [b(s2.db.lookup('intkey').buf) === '42', 'int-encoded string roundtrip'],
    [(s2.db.lookup('lst').list.toArray()).map(b).join(',') === 'a,b,c', 'list roundtrip'],
    [b(s2.db.lookup('hsh').map.get('f1')) === 'v1' && s2.db.lookup('hsh').map.size === 2, 'hash roundtrip'],
    [s2.db.lookup('ints').members().join(',') === '1,2,3', 'intset roundtrip'],
    [s2.db.lookup('strs').members().sort().join(',') === 'x,y,z', 'set roundtrip'],
    [(s2.db.lookup('zs').sl.toArray()).map((it) => it.member + '=' + it.score).join(',') === 'a=1.5,b=2.5', 'zset roundtrip'],
    [s2.keyspace.dbs[0].expires.get('tmp') > Date.now(), 'TTL roundtrip'],
    [b(s2.keyspace.dbs[3].lookup('otherdb').buf) === 'yes', 'multi-db roundtrip'],
    [count === 9, 'key count'],
  ];
  for (const [ok, label] of checks) {
    if (!ok) fail('part1: ' + label);
  }

  // Checksum: flip one byte in the body → must be rejected.
  const corrupt = Buffer.from(blob);
  corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
  let rejected = false;
  try { rdb.deserialize(s2, corrupt); } catch (e) { rejected = /checksum/i.test(e.message); }
  if (!rejected) fail('part1: corrupted RDB not rejected by CRC');
  console.log('PART1 (in-process roundtrip + CRC) PASSED');
}

/* ------------------------------ part 2 & 3 ------------------------------ */

const PORT1 = 9701 + Math.floor(Math.random() * 50);
const PORT2 = PORT1 + 1;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xredis-rdb-'));

function start(port) {
  const s = spawn('node', [
    path.join(__dirname, '../bin/xredis-server.js'),
    '--port', String(port), '--dir', DIR, '--appendonly', 'no', '--save', '',
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

async function part2() {
  let srv = start(PORT1);
  await waitPort(PORT1);
  let c = new Client({ port: PORT1 });
  await c.connect();
  await c.send(['SET', 'rdbstr', 'survived']);
  await c.send(['RPUSH', 'rdblist', 'p', 'q']);
  await c.send(['ZADD', 'rdbz', '3', 'm']);
  await c.send(['SET', 'rdbttl', 'v', 'EX', '500']);
  const save = await c.send(['SAVE']);
  if (save !== 'OK') fail('part2: SAVE returned ' + JSON.stringify(save));
  const dbsize = await c.send(['DBSIZE']);
  if (dbsize !== 4) fail('part2: dbsize ' + dbsize);
  c.close();
  srv.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));

  if (!fs.existsSync(path.join(DIR, 'dump.rdb'))) fail('part2: dump.rdb missing after SAVE');

  srv = start(PORT2);
  await waitPort(PORT2, 7000);
  c = new Client({ port: PORT2 });
  await c.connect();
  const v = b(await c.send(['GET', 'rdbstr']));
  if (v !== 'survived') fail('part2: RDB recovery GET rdbstr=' + JSON.stringify(v), srv.log);
  const lst = (await c.send(['LRANGE', 'rdblist', '0', '-1'])).map(b).join(',');
  if (lst !== 'p,q') fail('part2: RDB recovery LRANGE=' + lst, srv.log);
  const z = (await c.send(['ZRANGE', 'rdbz', '0', '-1', 'WITHSCORES'])).map(b).join(',');
  if (z !== 'm,3') fail('part2: RDB recovery ZRANGE=' + z, srv.log);
  const ttl = await c.send(['TTL', 'rdbttl']);
  if (!(ttl > 400 && ttl <= 500)) fail('part2: RDB recovery TTL=' + ttl, srv.log);
  if ((await c.send(['DBSIZE'])) !== 4) fail('part2: dbsize after recovery', srv.log);
  console.log('PART2 (crash recovery via RDB) PASSED');

  // Corrupt the RDB → next boot must refuse to load it but still boot.
  c.close();
  srv.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  const dump = fs.readFileSync(path.join(DIR, 'dump.rdb'));
  dump[40] ^= 0xff;
  fs.writeFileSync(path.join(DIR, 'dump.rdb'), dump);
  srv = start(PORT1 + 2);
  await waitPort(PORT1 + 2, 7000);
  const c2 = new Client({ port: PORT1 + 2 });
  await c2.connect();
  if ((await c2.send(['DBSIZE'])) !== 0) fail('part3: corrupt RDB was loaded', srv.log);
  console.log('PART3 (corrupt RDB rejected) PASSED');
  c2.close();
  srv.kill('SIGTERM');
  setTimeout(() => process.exit(0), 200);
}

part1();
part2().catch((e) => { console.error('RDB TEST FAILED: ' + e.message); process.exit(1); });
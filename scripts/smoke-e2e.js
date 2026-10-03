'use strict';

// End-to-end smoke test: boot a real server subprocess and hammer it with the
// RESP client to verify the full pipeline.

const { spawn } = require('child_process');
const { Client } = require('../src/client');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 7457 + Math.floor(Math.random() * 1000);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xredis-smoke-'));
let serverLog = '';

const server = spawn('node', [path.join(__dirname, '../bin/xredis-server.js'), '--port', String(PORT), '--dir', DIR, '--appendonly', 'yes'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitPort(port, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const try_ = () => {
      const c = new Client({ port });
      c.connect().then(() => { c.close(); resolve(); }).catch(() => {
        if (Date.now() - start > ms) reject(new Error('server did not come up'));
        else setTimeout(try_, 100);
      });
    };
    try_();
  });
}

function fail(msg) {
  console.log('FAIL ' + msg);
  console.log('server log:\n' + serverLog);
  server.kill('SIGKILL');
  process.exit(1);
}

function assertEq(actual, expected, label) {
  const ok = expected === true ? Boolean(actual) : actual === expected;
  if (!ok) fail(`${label}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}

const bufs = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : b);

async function main() {
  await waitPort(PORT, 5000);
  const c = new Client({ port: PORT });
  await c.connect();

  assertEq(await c.send(['PING']), 'PONG', 'PING');
  assertEq(bufs(await c.send(['SET', 'greeting', 'hello'])), 'OK', 'SET');
  assertEq(bufs(await c.send(['GET', 'greeting'])), 'hello', 'GET');
  assertEq(await c.send(['SET', 'no', 'firstvalue']), 'OK', 'SET baseline');
  assertEq(await c.send(['SET', 'no', 'x', 'NX']), null, 'SET NX exists');
  assertEq(bufs(await c.send(['GET', 'no'])), 'firstvalue', 'NX preserved original');
  assertEq(await c.send(['SETNX', 'fresh', 'ok']), 1, 'SETNX');
  assertEq(await c.send(['APPEND', 'greeting', ' world']), 11, 'APPEND');
  assertEq(bufs(await c.send(['GET', 'greeting'])), 'hello world', 'GET after append');
  assertEq(await c.send(['INCR', 'counter']), 1, 'INCR');
  assertEq(await c.send(['INCRBY', 'counter', '10']), 11, 'INCRBY');

  assertEq(await c.send(['RPUSH', 'mylist', 'a', 'b', 'c']), 3, 'RPUSH');
  assertEq(await c.send(['LPUSH', 'mylist', 'z']), 4, 'LPUSH');
  const lr = await c.send(['LRANGE', 'mylist', '0', '-1']);
  assertEq(lr.map(bufs).join(','), 'z,a,b,c', 'LRANGE');
  assertEq(bufs(await c.send(['LPOP', 'mylist'])), 'z', 'LPOP');
  assertEq(await c.send(['LLEN', 'mylist']), 3, 'LLEN');

  assertEq(await c.send(['HSET', 'h', 'f1', 'v1', 'f2', 'v2']), 2, 'HSET');
  assertEq(bufs(await c.send(['HGET', 'h', 'f1'])), 'v1', 'HGET');
  assertEq(await c.send(['HINCRBY', 'h', 'f3', '5']), 5, 'HINCRBY');
  const hg = await c.send(['HGETALL', 'h']);
  assertEq(hg.map(bufs).join('/'), 'f1/v1/f2/v2/f3/5', 'HGETALL');

  assertEq(await c.send(['SADD', 's', 'm1', 'm2', 'm3']), 3, 'SADD');
  assertEq(await c.send(['SISMEMBER', 's', 'm2']), 1, 'SISMEMBER');
  assertEq(await c.send(['SCARD', 's']), 3, 'SCARD');
  const sm = (await c.send(['SMEMBERS', 's'])).map(bufs).sort();
  assertEq(sm.join(','), 'm1,m2,m3', 'SMEMBERS');

  assertEq(await c.send(['ZADD', 'z', '1', 'a', '2', 'b', '3', 'c']), 3, 'ZADD');
  assertEq(bufs(await c.send(['ZSCORE', 'z', 'b'])), '2', 'ZSCORE');
  const zr = await c.send(['ZRANGE', 'z', '0', '-1']);
  assertEq(zr.map(bufs).join(','), 'a,b,c', 'ZRANGE');
  const zrws = await c.send(['ZRANGE', 'z', '0', '-1', 'WITHSCORES']);
  assertEq(zrws.map(bufs).join(','), 'a,1,b,2,c,3', 'ZRANGE WITHSCORES');
  assertEq(await c.send(['ZRANK', 'z', 'c']), 2, 'ZRANK');

  // ZINTERSTORE / ZUNIONSTORE with weights + aggregate
  await c.send(['ZADD', 'z1', '1', 'a', '2', 'b', '3', 'c']);
  await c.send(['ZADD', 'z2', '10', 'b', '20', 'c', '30', 'd']);
  assertEq(await c.send(['ZINTERSTORE', 'zi', '2', 'z1', 'z2']), 2, 'ZINTERSTORE count');
  const zi = await c.send(['ZRANGE', 'zi', '0', '-1', 'WITHSCORES']);
  assertEq(zi.map(bufs).join(','), 'b,12,c,23', 'ZINTERSTORE scores');
  assertEq(await c.send(['ZUNIONSTORE', 'zu', '2', 'z1', 'z2']), 4, 'ZUNIONSTORE count');
  const zu = await c.send(['ZRANGE', 'zu', '0', '-1', 'WITHSCORES']);
  assertEq(zu.map(bufs).join(','), 'a,1,b,12,c,23,d,30', 'ZUNIONSTORE scores');
  assertEq(await c.send(['ZUNIONSTORE', 'zum', '2', 'z1', 'z2', 'WEIGHTS', '2', '1', 'AGGREGATE', 'MAX']), 4, 'ZUNIONSTORE options');
  const zum = await c.send(['ZSCORE', 'zum', 'c']);
  assertEq(bufs(zum), '20', 'ZUNIONSTORE WEIGHTS+MAX');
  // dst may be one of the sources
  assertEq(await c.send(['ZINTERSTORE', 'z1', '2', 'z1', 'z2']), 2, 'ZINTERSTORE in-place');
  assertEq(bufs(await c.send(['ZSCORE', 'z1', 'b'])), '12', 'ZINTERSTORE in-place score');

  assertEq(await c.send(['EXPIRE', 'greeting', '100']), 1, 'EXPIRE');
  assertEq(await c.send(['TTL', 'greeting']) > 90, true, 'TTL');
  await c.send(['SET', 'boom', '1']);
  assertEq(await c.send(['PEXPIRE', 'boom', '50']), 1, 'PEXPIRE');
  await sleep(80);
  assertEq(await c.send(['GET', 'boom']), null, 'expired GET');

  // EXPIRE condition options (Redis 7 semantics).
  await c.send(['SET', 't1', 'v']);
  assertEq(await c.send(['EXPIRE', 't1', '100', 'NX']), 1, 'EXPIRE NX on key without ttl');
  assertEq(await c.send(['EXPIRE', 't1', '200', 'NX']), 0, 'EXPIRE NX on key with ttl');
  assertEq(await c.send(['EXPIRE', 't1', '200']), 1, 'EXPIRE plain overwrite');
  await c.send(['SET', 't2', 'v']);
  assertEq(await c.send(['EXPIRE', 't2', '100', 'XX']), 0, 'EXPIRE XX without ttl');
  assertEq(await c.send(['TTL', 't2']), -1, 'EXPIRE XX left ttl untouched');
  assertEq(await c.send(['EXPIRE', 't1', '50', 'LT']), 1, 'EXPIRE LT smaller');
  assertEq(await c.send(['EXPIRE', 't1', '10', 'GT']), 0, 'EXPIRE GT smaller rejected');
  let conflict = false;
  try { await c.send(['EXPIRE', 't1', '10', 'NX', 'GT']); } catch (e) { conflict = e.message.includes('not compatible'); }
  assertEq(conflict, true, 'EXPIRE NX+GT rejected');
  assertEq(await c.send(['EXPIRE', 't2', '1', 'LT']), 1, 'EXPIRE LT on key without ttl');

  try {
    await c.send(['SET', 'mylist', 'x']);
    fail('SET on list should throw');
  } catch (e) {
    assertEq(e.message.startsWith('WRONGTYPE'), true, 'WRONGTYPE error');
  }

  // ----- phase two (transactions / pubsub / keyspace / admin) -----
  await phaseTwo(c, PORT, DIR);
}

async function phaseTwo(c, PORT) {
  assertEq(await c.send(['MULTI']), 'OK', 'MULTI');
  assertEq(await c.send(['SET', 'tx1', '1']), 'QUEUED', 'queue SET');
  assertEq(await c.send(['INCR', 'counter']), 'QUEUED', 'queue INCR');
  const ex = await c.send(['EXEC']);
  assertEq(ex.length, 2, 'EXEC reply count');
  assertEq(ex[0], 'OK', 'EXEC[0]');
  assertEq(ex[1], 12, 'EXEC[1]');

  const sub = new Client({ port: PORT });
  await sub.connect();
  const sr = await sub.send(['SUBSCRIBE', 'chan']);
  assertEq(Array.isArray(sr) && sr.length === 3, true, 'SUBSCRIBE reply');
  const msgPromise = sub.next();
  const n = await c.send(['PUBLISH', 'chan', 'payload1']);
  assertEq(n, 1, 'PUBLISH count');
  const msg = await msgPromise;
  assertEq(Array.isArray(msg) && msg.map(bufs).join('/'), 'message/chan/payload1', 'message content');
  sub.close();

  assertEq(await c.send(['EXISTS', 'greeting', 'h', 'counter']), 3, 'EXISTS');
  assertEq(await c.send(['DEL', 'h']), 1, 'DEL');
  const keys = (await c.send(['KEYS', '*'])).map(bufs);
  assertEq(keys.includes('counter'), true, 'KEYS');
  const cfg = await c.send(['CONFIG', 'GET', 'maxmemory*']);
  assertEq(Array.isArray(cfg), true, 'CONFIG GET');
  const info = bufs(await c.send(['INFO', 'server']));
  assertEq(info.includes('redis_version'), true, 'INFO server');
  const scan = await c.send(['SCAN', '0']);
  assertEq(scan.length, 2, 'SCAN structure');

  assertEq(await c.send(['SELECT', '1']), 'OK', 'SELECT 1');
  assertEq(await c.send(['DBSIZE']), 0, 'DBSIZE db1');
  assertEq(await c.send(['SET', 'onlydb1', 'v']), 'OK', 'set in db1');
  assertEq(await c.send(['SELECT', '0']), 'OK', 'SELECT 0');
  assertEq(await c.send(['GET', 'onlydb1']), null, 'db isolation');
  assertEq(await c.send(['DBSIZE']) >= 6, true, 'DBSIZE db0');
  const infoFull = bufs(await c.send(['INFO']));
  assertEq(infoFull.includes('# Keyspace'), true, 'INFO includes keyspace');

  // ----- phase three (scripting / RESP3 client / failure paths) -----
  await phaseThree(c, PORT);
}

async function phaseThree(c, PORT) {
  const net = require('net');

  // Lua scripting.
  assertEq(await c.send(['EVAL', 'return 1', '0']), 1, 'EVAL scalar');
  await c.send(['EVAL', "redis.call('SET', KEYS[1], ARGV[1]); return redis.call('GET', KEYS[1])", '1', 'luakey', 'luaval']);
  assertEq(bufs(await c.send(['GET', 'luakey'])), 'luaval', 'EVAL redis.call effect');
  const sha = bufs(await c.send(['SCRIPT', 'LOAD', 'return 42']));
  assertEq(sha.length, 40, 'SCRIPT LOAD sha');
  assertEq(await c.send(['EVALSHA', sha, '0']), 42, 'EVALSHA');
  assertEq((await c.send(['SCRIPT', 'EXISTS', sha, 'zzz'])).join(','), '1,0', 'SCRIPT EXISTS');

  // RESP3 client: HELLO 3 returns a map, typed nulls/bools/doubles decode.
  const c3 = new Client({ port: PORT });
  await c3.connect();
  const hello = await c3.send(['HELLO', '3']);
  assertEq(hello !== null && typeof hello === 'object' && bufs(hello.server) === 'redis', true, 'HELLO 3 map decode');
  assertEq(await c3.send(['GET', 'no-such-key']), null, 'RESP3 typed null decode');
  assertEq(await c3.send(['EVAL', 'return 3.14', '0']), 3.14, 'RESP3 double decode');
  c3.close();

  // A bad bulk terminator (declared length present, but no CRLF) is a
  // protocol error: the server must reply with an error and close the socket.
  const closed = await new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port: PORT }, () => {
      sock.write('*2\r\n$3\r\nSET\r\n$2\r\nabXY');
    });
    sock.on('error', () => {});   // connection errors resolve via 'close'
    sock.on('data', () => {});
    sock.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 2000);
  });
  assertEq(closed, true, 'bad bulk terminator disconnects');

  // Requests pending on a connection that dies must reject (not hang).
  const fake = net.createServer((sock) => { setTimeout(() => sock.destroy(), 100); });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const c4 = new Client({ port: fake.address().port });
  await c4.connect();
  const outcome = await Promise.race([
    c4.send(['GET', 'x']).then(() => 'resolved', () => 'rejected'),
    new Promise((r) => setTimeout(() => r('timeout'), 1500)),
  ]);
  fake.close();
  assertEq(outcome, 'rejected', 'pending rejects on connection close (got ' + outcome + ')');

  c.close();
  console.log('ALL SMOKE CHECKS PASSED');
  server.kill('SIGTERM');
  setTimeout(() => process.exit(0), 300);
}

if (require.main === module) {
  main().catch((e) => {
    fail('exception: ' + e.message);
  });
}
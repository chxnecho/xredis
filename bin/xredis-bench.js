#!/usr/bin/env node
'use strict';

// xredis-bench: a small redis-benchmark clone. Runs N commands across C
// pipelined clients and reports throughput plus latency percentiles.

const { Client } = require('../src/client');
const { xredisVersion } = require('../src/version');

function usage() {
  console.log(`Usage: xredis-bench [options]

Options:
  -h <host>        server hostname (default 127.0.0.1)
  -p <port>        server port (default 6379)
  -c <clients>     number of parallel connections (default 50)
  -n <requests>    total number of requests (default 100000)
  -t <cmds>        comma-separated command mix: set,get,incr,lpush,lpop (default set,get)
  -d <size>        data size of the value in bytes (default 16)
  -P <num>         pipeline <num> requests per connection (default 1)
  -q               quiet mode: only show summary
`);
}

function parseArgs(argv) {
  const o = { host: '127.0.0.1', port: 6379, clients: 50, requests: 100000, cmds: ['set', 'get'], size: 16, pipeline: 1, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') o.host = argv[++i];
    else if (a === '-p') o.port = Number(argv[++i]);
    else if (a === '-c') o.clients = Number(argv[++i]);
    else if (a === '-n') o.requests = Number(argv[++i]);
    else if (a === '-t') o.cmds = argv[++i].split(',');
    else if (a === '-d') o.size = Number(argv[++i]);
    else if (a === '-P') o.pipeline = Number(argv[++i]);
    else if (a === '-q') o.quiet = true;
    else if (a === '--help' || a === '-?') { usage(); process.exit(0); }
  }
  return o;
}

const LAT = [];

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function runWorker(opts, id, payload, onStart, onDone) {
  const c = new Client({ host: opts.host, port: opts.port });
  await c.connect();
  let sent = 0;
  const mine = [];
  const per = Math.ceil(opts.requests / opts.clients);
  const start = onStart(per);
  const rand = () => Math.floor(Math.random() * 1e9);
  const build = (kind, i) => {
    switch (kind) {
      case 'set': return ['SET', `bench:key:${id}:${i}`, payload];
      case 'get': return ['GET', `bench:key:${id}:${i % per}`];
      case 'incr': return ['INCR', `bench:counter:${id}:${i % 1000}`];
      case 'lpush': return ['LPUSH', `bench:list:${id}:${i % 100}`, payload];
      case 'lpop': return ['LPOP', `bench:list:${id}:${i % 100}`];
      default: return ['PING'];
    }
  };
  await new Promise((resolve) => {
    const pump = () => {
      while (sent < start + per) {
        const kind = opts.cmds[Math.floor(Math.random() * opts.cmds.length)];
        const batch = [];
        for (let p = 0; p < opts.pipeline && sent < start + per; p++, sent++) {
          batch.push({ cmd: build(kind, sent), t0: process.hrtime.bigint() });
        }
        for (const item of batch) c.send(item.cmd).then(() => {
          const dt = Number(process.hrtime.bigint() - item.t0) / 1e6;
          LAT.push(dt);
          if (LAT.length === opts.requests) { resolve(); return; }
        }).catch(() => {
          if (LAT.length === opts.requests) resolve();
        });
        if (batch.length) { setImmediate(pump); return; }
      }
      // Wait for outstanding replies.
      const check = setInterval(() => {
        if (LAT.length >= opts.requests) { clearInterval(check); resolve(); }
      }, 10);
    };
    pump();
  });
  c.close();
  onDone();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`xredis-bench v${xredisVersion} — ${opts.requests} ops, ${opts.clients} clients, pipeline ${opts.pipeline}`);
  const payload = Buffer.alloc(opts.size, 0x78); // 'x'
  let nextStart = 0;
  const onStart = (per) => { const s = nextStart; nextStart += per; return s; };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: opts.clients }, (_, id) => runWorker(opts, id, payload, onStart, () => {})));
  const elapsed = (Date.now() - t0) / 1000;
  LAT.sort((a, b) => a - b);
  const qps = Math.round(opts.requests / elapsed);
  const summary =
    `\n${'='.repeat(46)}\n` +
    ` Throughput:  ${qps.toLocaleString()} ops/sec\n` +
    ` Total:       ${opts.requests.toLocaleString()} ops in ${elapsed.toFixed(2)}s\n` +
    ` Latency p50: ${pct(LAT, 50).toFixed(3)} ms\n` +
    ` Latency p90: ${pct(LAT, 90).toFixed(3)} ms\n` +
    ` Latency p99: ${pct(LAT, 99).toFixed(3)} ms\n` +
    ` Latency max: ${(LAT[LAT.length - 1] || 0).toFixed(3)} ms\n` +
    `${'='.repeat(46)}`;
  if (opts.quiet) console.log(summary);
  else console.log(summary);
}

main().catch((e) => { console.error('bench failed: ' + e.message); process.exit(1); });
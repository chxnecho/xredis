#!/usr/bin/env node
'use strict';

// xredis-cli: interactive command-line client (a tiny redis-cli clone).

const { Client } = require('../src/client');
const { xredisVersion } = require('../src/version');
const readline = require('readline');

function parseLine(line) {
  const argv = [];
  let cur = '';
  let hasCur = false;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; hasCur = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (hasCur || cur.length) { argv.push(cur); cur = ''; hasCur = false; }
      continue;
    }
    cur += ch;
    hasCur = true;
  }
  if (hasCur || cur.length) argv.push(cur);
  return argv;
}

function fmt(v, indent = '') {
  if (v === null || v === undefined) return '(nil)';
  if (Buffer.isBuffer(v)) {
    const s = v.toString('utf8');
    return `"${s}"`;
  }
  if (typeof v === 'number') return `(integer) ${v}`;
  if (typeof v === 'string') return `"${v}"`;
  if (Array.isArray(v)) {
    if (v.length === 0) return '(empty array)';
    const lines = v.map((x, i) => `${indent}${i + 1}) ${fmt(x, indent + '    ')}`);
    return lines.join('\n');
  }
  if (v && v.__error) return `(error) ${v.__error.message}`;
  return String(v);
}

async function main() {
  const args = process.argv.slice(2);
  let host = '127.0.0.1';
  let port = 6379;
  let password = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-h') host = args[++i];
    else if (args[i] === '-p') port = Number(args[++i]);
    else if (args[i] === '-a') password = args[++i];
    else if (args[i] === '-v') { console.log(`xredis-cli v${xredisVersion}`); return; }
  }

  const c = new Client({ host, port, password });
  try {
    await c.connect();
  } catch (e) {
    console.error(`Could not connect to xredis at ${host}:${port}: ${e.message}`);
    process.exit(1);
  }

  console.log(`xredis-cli  v${xredisVersion}  (connected to ${host}:${port})`);
  console.log('Type "help" for hints, Ctrl+C or "quit" to exit.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${host}:${port}> ` });
  rl.prompt();
  rl.on('line', async (line) => {
    const argv = parseLine(line.trim());
    if (!argv.length) { rl.prompt(); return; }
    const cmd = argv[0].toLowerCase();
    if (cmd === 'quit' || cmd === 'exit') { c.close(); process.exit(0); }
    if (cmd === 'help') {
      console.log('Type any xredis command, e.g. SET key value, GET key, ZADD z 1 a, SUBSCRIBE chan.');
      rl.prompt();
      return;
    }
    try {
      const reply = await c.send(argv);
      console.log(fmt(reply));
    } catch (e) {
      console.log(`(error) ${e.message}`);
    }
    rl.prompt();
  });
  rl.on('close', () => { c.close(); process.exit(0); });
}

main().catch((e) => { console.error(e.message); process.exit(1); });
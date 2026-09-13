'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  bind: '127.0.0.1',
  port: 6379,
  unixsocket: '',
  databases: 16,
  maxclients: 10000,
  timeout: 0,
  'tcp-keepalive': 300,
  'tcp-backlog': 511,
  requirepass: '',
  masterauth: '',
  appendonly: 'yes',
  appendfilename: 'appendonly.aof',
  appendfsync: 'everysec',
  'aof-load-truncated': 'yes',
  'auto-aof-rewrite-percentage': 100,
  'auto-aof-rewrite-min-size': '64mb',
  'no-appendfsync-on-rewrite': 'no',
  save: '3600 1 300 100 60 10000',
  dbfilename: 'dump.rdb',
  rdbcompression: 'yes',
  maxmemory: '0',
  'maxmemory-policy': 'noeviction',
  'maxmemory-samples': 5,
  'proto-max-bulk-len': '512mb',
  'client-output-buffer-limit': 'normal 0 0 0 replica 256mb 64mb 60 pubsub 32mb 8mb 60',
  'active-expire-enabled': 'yes',
  'repl-backlog-size': '1mb',
  loglevel: 'notice',
  logfile: '',
  daemonize: 'no',
  'always-show-logo': 'yes',
  'aof-rewrite-on-save': 'yes',
};

const ENUMS = {
  'appendfsync': ['always', 'everysec', 'no'],
  appendonly: ['yes', 'no'],
  'aof-load-truncated': ['yes', 'no'],
  rdbcompression: ['yes', 'no'],
  'no-appendfsync-on-rewrite': ['yes', 'no'],
  daemonize: ['yes', 'no'],
  'always-show-logo': ['yes', 'no'],
  'active-expire-enabled': ['yes', 'no'],
  'maxmemory-policy': ['noeviction', 'allkeys-lru', 'allkeys-random', 'volatile-lru', 'volatile-random', 'allkeys-lfu', 'volatile-lfu'],
  'aof-rewrite-on-save': ['yes', 'no'],
};

function parseSize(s) {
  if (typeof s === 'number') return s;
  const m = /^(\d+)([a-zA-Z]*)$/.exec(s.trim());
  if (!m) throw new Error(`illegal size ${s}`);
  const unit = m[2].toLowerCase();
  const mult = { '': 1, b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4 }[unit];
  if (mult === undefined) throw new Error(`illegal size ${s}`);
  return Number(m[1]) * mult;
}

function parseSave(spec) {
  if (typeof spec !== 'string') return spec;
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed === 'no' || trimmed === 'false') return [];
  const nums = trimmed.split(/\s+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

function parseBufLimit(spec) {
  const out = {};
  const toks = String(spec).split(/\s+/);
  for (let i = 0; i + 3 < toks.length; i += 4) {
    const cls = toks[i];
    out[cls] = { hard: parseSize(toks[i + 1]), soft: parseSize(toks[i + 2]), softSec: Number(toks[i + 3] || 0) };
  }
  return out;
}

function applyValue(cfg, key, value) {
  const enums = ENUMS[key];
  if (enums && !enums.includes(String(value))) {
    throw new Error(`argument must be ${enums.map((e) => `'${e}'`).join(' or ')}`);
  }
  cfg[key] = value;
}

function loadConfFile(cfg, file) {
  const raw = fs.readFileSync(file, 'utf8');
  const known = new Set(Object.keys(DEFAULTS));
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#') || t.startsWith(';')) continue;
    let i = 0;
    while (i < t.length && !/\s/.test(t[i])) i++;
    const key = t.slice(0, i);
    if (key === 'save') { cfg.save = parseSave(t.slice(i).trim()); continue; }
    if (key === 'client-output-buffer-limit') { cfg['client-output-buffer-limit'] = parseBufLimit(t.slice(i).trim()); continue; }
    if (!known.has(key)) continue;
    applyValue(cfg, key, t.slice(i).trim());
  }
  return cfg;
}

function parseCliArgs(args, cwd) {
  const cfg = { ...DEFAULTS };
  cfg.save = parseSave(DEFAULTS.save);
  cfg['client-output-buffer-limit'] = parseBufLimit(DEFAULTS['client-output-buffer-limit']);
  let confPath = null;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    const take = () => {
      if (i + 1 >= args.length) throw new Error(`missing argument for ${a}`);
      return args[++i];
    };
    switch (a) {
      case '--help': case '-h': return { help: true, cfg };
      case '--version': case '-v': return { version: true, cfg };
      case '--conf': case '--config': confPath = path.resolve(cwd, take()); break;
      case '--port': case '-p': cfg.port = Number(take()); break;
      case '--bind': case '--host': cfg.bind = take(); break;
      case '--unixsocket': cfg.unixsocket = take(); break;
      case '--requirepass': cfg.requirepass = take(); break;
      case '--masterauth': cfg.masterauth = take(); break;
      case '--appendonly': applyValue(cfg, 'appendonly', take()); break;
      case '--appendfsync': applyValue(cfg, 'appendfsync', take()); break;
      case '--appendfilename': cfg.appendfilename = take(); break;
      case '--dbfilename': cfg.dbfilename = take(); break;
      case '--dir': cfg.dir = take(); break;
      case '--save': cfg.save = parseSave(take()); break;
      case '--maxmemory': cfg.maxmemory = parseSize(take()); break;
      case '--maxmemory-policy': applyValue(cfg, 'maxmemory-policy', take()); break;
      case '--proto-max-bulk-len': cfg['proto-max-bulk-len'] = parseSize(take()); break;
      case '--databases': cfg.databases = Number(take()); break;
      case '--maxclients': cfg.maxclients = Number(take()); break;
      case '--timeout': cfg.timeout = Number(take()); break;
      case '--replicaof': case '--slaveof': cfg.replicaof = { host: take(), port: Number(take()) }; break;
      case '--loglevel': applyValue(cfg, 'loglevel', take()); break;
      case '--logfile': cfg.logfile = take(); break;
      case '--daemonize': applyValue(cfg, 'daemonize', take()); break;
      case '--active-expire-enabled': applyValue(cfg, 'active-expire-enabled', take()); break;
      case '--repl-backlog-size': cfg['repl-backlog-size'] = parseSize(take()); break;
      default: i++;
    }
    i++;
  }
  return { cfg, confPath, help: false, version: false };
}

function configure(args, { cwd = process.cwd() } = {}) {
  const { cfg, confPath, help, version } = parseCliArgs(args, cwd);
  if (help || version) return { cfg, help, version };
  if (confPath) loadConfFile(cfg, confPath);
  for (const k of ['maxmemory', 'proto-max-bulk-len', 'repl-backlog-size', 'auto-aof-rewrite-min-size']) {
    cfg[k] = parseSize(cfg[k]);
  }
  if (!cfg.dir) cfg.dir = cwd;
  else cfg.dir = path.resolve(cwd, cfg.dir);
  cfg.clientOutputBufferLimit = cfg['client-output-buffer-limit'];
  delete cfg['client-output-buffer-limit'];
  cfg.appendonly = cfg.appendonly === 'yes';
  cfg.aofLoadTruncated = cfg['aof-load-truncated'] === 'yes';
  cfg.rdbCompression = cfg.rdbcompression === 'yes';
  cfg.activeExpire = cfg['active-expire-enabled'] === 'yes';
  cfg.replBacklogSize = cfg['repl-backlog-size'];
  cfg.pidfile = path.join(cfg.dir, 'xredis.pid');
  return { cfg, help, version };
}

module.exports = { DEFAULTS, configure, parseSize, parseSave, parseBufLimit, loadConfFile, applyValue };
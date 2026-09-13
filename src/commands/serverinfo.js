'use strict';

// Server-context commands: INFO, CONFIG, TIME, COMMAND, LASTSAVE, DBSIZE.

const os = require('os');
const { toStr, err, globMatch } = require('../util');
const P = require('../protocol');
const { xredisVersion } = require('../version');

function cmdInfo(server, argv, ctx) {
  const sectionArg = argv.length > 1 ? toStr(argv[1]).toLowerCase() : 'default';
  const now = Date.now();
  const memUsed = process.memoryUsage();
  const uptime = Math.floor((now - server.stats.startedAt) / 1000);

  const wraps = (title, lines) => ['# ' + title, ...lines, ''].join('\r\n');

  const serverSection = wraps('Server', [
    'redis_version:7.4.0',
    'redis_git_sha1:00000000',
    'redis_git_dirty:0',
    'redis_build_id:xredis-' + xredisVersion,
    'redis_mode:standalone',
    'os:' + os.platform() + ' ' + os.release(),
    'arch_bits:64',
    'process_id:' + process.pid,
    'run_id:' + server.runId,
    'tcp_port:' + server.config.port,
    'uptime_in_seconds:' + uptime,
    'uptime_in_days:' + Math.floor(uptime / 86400),
    'hz:10',
    'configured_hz:10',
    'config_file:' + (server.configFile || ''),
  ]);

  const clientSection = wraps('Clients', [
    'connected_clients:' + server.clients.length,
    'cluster_connections:0',
    'maxclients:' + server.config.maxclients,
    'client_recent_max_input_buffer:0',
    'blocked_clients:0',
    'tracking_clients:0',
    'pubsub_clients:' + server.clients.filter((c) => c.subCount > 0).length,
    'watching_clients:' + server.clients.filter((c) => c.watched && c.watched.size).length,
  ]);

  const memorySection = wraps('Memory', [
    'used_memory:' + memUsed.heapUsed,
    'used_memory_human:' + (memUsed.heapUsed / 1024 / 1024).toFixed(2) + 'M',
    'used_memory_rss:' + memUsed.rss,
    'used_memory_peak:' + memUsed.heapUsed,
    'used_memory_lua:0',
    'maxmemory:' + server.config.maxmemory,
    'maxmemory_human:' + (server.config.maxmemory / 1024 / 1024).toFixed(2) + 'M',
    'maxmemory_policy:' + server.config['maxmemory-policy'],
    'mem_fragmentation_ratio:1.00',
    'mem_allocator:libc',
  ]);

  const statsSection = wraps('Stats', [
    'total_connections_received:' + server.stats.connectionsReceived,
    'total_commands_processed:' + server.stats.commands,
    'instantaneous_ops_per_sec:0',
    'total_net_input_bytes:' + server.stats.netInput,
    'total_net_output_bytes:' + server.stats.netOutput,
    'rejected_connections:' + server.stats.rejected,
    'pubsub_channels:' + server.pubsub.channels.size,
    'pubsub_patterns:' + server.pubsub.patterns.size,
    'keyspace_hits:' + server.stats.keyspaceHits,
    'keyspace_misses:' + server.stats.keyspaceMisses,
    'expired_keys:' + server.stats.expired,
    'evicted_keys:' + server.stats.evicted,
  ]);

  const replLines = ['role:' + (server.role === 'master' ? 'master' : 'slave')];
  replLines.push('connected_slaves:' + server.replicas.length);
  server.replicas.forEach((r, i) => {
    replLines.push('slave' + i + ':ip=' + r.host + ',port=' + r.port + ',state=online,offset=0,lag=0');
  });
  if (server.role !== 'master') {
    replLines.push('master_host:' + server.config.replicaof.host);
    replLines.push('master_port:' + server.config.replicaof.port);
    replLines.push('master_link_status:up');
    replLines.push('slave_read_only:1');
  } else {
    replLines.push('master_replid:' + server.replid);
    replLines.push('master_replid2:' + '0'.repeat(40));
    replLines.push('master_repl_offset:' + server.replOffset);
    replLines.push('second_repl_offset:-1');
  }
  const replicationSection = wraps('Replication', replLines);

  const keyspaceLines = [];
  for (const db of server.keyspace.all()) {
    keyspaceLines.push(`db${db.id}:keys=${db.size},expires=${db.expires.size},avg_ttl=0`);
  }
  const keyspaceSection = wraps('Keyspace', keyspaceLines);

  const want = (n) => sectionArg === 'default' || sectionArg === 'all' || sectionArg === n;
  const sections = [];
  if (want('server')) sections.push(serverSection);
  if (want('clients')) sections.push(clientSection);
  if (want('memory')) sections.push(memorySection);
  if (want('stats')) sections.push(statsSection);
  if (want('replication')) sections.push(replicationSection);
  if (want('keyspace')) sections.push(keyspaceSection);

  return ctx.bulk(Buffer.from(sections.join('\r\n'), 'latin1'));
}

const CONFIG_KEYS = [
  'maxmemory', 'maxmemory-policy', 'appendonly', 'appendfsync', 'save', 'dir',
  'dbfilename', 'appendfilename', 'appenddirname', 'auto-aof-rewrite-percentage',
  'auto-aof-rewrite-min-size', 'requirepass', 'masterauth', 'timeout', 'databases',
  'port', 'bind', 'maxclients', 'proto-max-bulk-len', 'loglevel', 'logfile',
  'active-expire-enabled', 'repl-backlog-size', 'no-appendfsync-on-rewrite',
  'aof-load-truncated', 'daemonize', 'tcp-keepalive', 'tcp-backlog',
];

function cfgValue(cfg, k) {
  const v = cfg[k];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v.map(String).join(' ') : String(v);
}

function cmdConfig(server, argv, ctx) {
  const sub = toStr(argv[1]).toUpperCase();
  if (sub === 'GET') {
    const glob = toStr(argv[2]);
    const out = [];
    for (const k of CONFIG_KEYS) {
      const v = cfgValue(server.config, k);
      if (v === undefined) continue;
      if (!globMatch(glob, k)) continue;
      out.push(P.encBulk(Buffer.from(k, 'latin1')), P.encBulk(Buffer.from(v, 'latin1')));
    }
    return ctx.arr(out);
  }
  if (sub === 'SET') {
    const k = toStr(argv[2]).toLowerCase();
    const v = toStr(argv[3]);
    switch (k) {
      case 'maxmemory':
        server.config.maxmemory = Number(v);
        break;
      case 'maxmemory-policy':
        server.config['maxmemory-policy'] = v;
        break;
      case 'appendonly':
        server.config.appendonly = v === 'yes';
        if (server.aof) server.aof.setEnabled(server.config.appendonly);
        break;
      case 'appendfsync':
        server.config.appendfsync = v;
        if (server.aof) server.aof.setFsync(v);
        break;
      case 'requirepass': server.config.requirepass = v; break;
      case 'masterauth': server.config.masterauth = v; break;
      case 'timeout': server.config.timeout = Number(v); break;
      case 'loglevel': server.config.loglevel = v; break;
      case 'active-expire-enabled': server.config.activeExpire = v === 'yes'; break;
      case 'notify-keyspace-events': break;
      case 'save':
        server.config.save = v.split(/\s+/).map(Number);
        break;
      default:
        throw err('ERR Unsupported CONFIG parameter: ' + k);
    }
    return ctx.ok();
  }
  if (sub === 'REWRITE') {
    server.configDirty = true;
    return ctx.ok();
  }
  if (sub === 'RESETSTAT') {
    server.stats.commands = 0;
    return ctx.ok();
  }
  throw err('ERR Unknown subcommand or wrong number of arguments for \'' + toStr(argv[1]) + '\'. Try CONFIG HELP.');
}

function cmdTime(server, argv, ctx) {
  const now = Date.now();
  return ctx.arr([
    P.encBulk(Buffer.from(String(Math.floor(now / 1000)), 'latin1')),
    P.encBulk(Buffer.from(String((now % 1000) * 1000), 'latin1')),
  ]);
}

function cmdCommand(server, argv, ctx) {
  const sub = argv.length > 1 ? toStr(argv[1]).toUpperCase() : '';
  if (sub === 'COUNT') return ctx.int(server.commands.size);
  if (sub === 'INFO') {
    const out = [];
    if (argv.length > 2) {
      for (let i = 2; i < argv.length; i++) {
        const c = server.commands.get(toStr(argv[i]).toLowerCase());
        out.push(c ? P.encArr(commandMeta(c)) : P.encNull());
      }
    } else {
      for (const c of server.commands.values()) out.push(P.encArr(commandMeta(c)));
    }
    return ctx.arr(out);
  }
  if (sub === 'DOCS') return ctx.arr([]);
  if (sub === 'GETKEYS') return ctx.arr([]);
  return ctx.arr([]);
}

function commandMeta(c) {
  return [
    P.encBulk(Buffer.from(c.name, 'latin1')),
    P.encInt(c.arity),
    P.encArr(c.flags.map((f) => P.encBulk(Buffer.from(f, 'latin1')))),
    P.encInt(c.firstKey),
    P.encInt(c.lastKey),
    P.encInt(c.keyStep),
  ];
}

function cmdDbsize(server, argv, ctx) {
  return ctx.int(server.db.size);
}

function cmdLastSave(server, argv, ctx) {
  return ctx.int(Math.floor((server.stats.lastSave || Date.now()) / 1000));
}

module.exports = { cmdInfo, cmdConfig, cmdTime, cmdCommand, cmdDbsize, cmdLastSave };
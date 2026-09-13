'use strict';

// xredis-server entry point: parses CLI args like an actual Redis binary,
// wires signal handling and starts the server.

const fs = require('fs');
const path = require('path');
const { configure } = require('./config');
const { RedisServer } = require('./server');
const { xredisVersion } = require('./version');

function printHelp() {
  console.log(`Usage: xredis-server [/path/to/xredis.conf] [options]
       xredis-server (/path/to/xredis.conf file.conf)
       xredis-server --port <port> --appendonly yes/no ...

Options:
  --port <port>              TCP port to listen on
  --bind <addr>              Address to bind
  --unixsocket <path>        Unix socket path
  --requirepass <password>   Set the password
  --appendonly <yes|no>      Enable AOF persistence
  --appendfsync <policy>     always | everysec | no
  --dir <dir>                Working directory
  --dbfilename <file>        RDB filename
  --save <sec changes ...>   RDB snapshot schedule
  --maxmemory <bytes>        Memory limit
  --replicaof <host> <port>  Replicate from another instance
  --daemonize <yes|no>       Run in background (Unix only)
  --logfile <file>           Log file
  --loglevel <level>         debug | verbose | notice | warning
  -v, --version              Print version
  -h, --help                 This help
`);
}

function writePid(cfg) {
  try {
    fs.mkdirSync(cfg.dir, { recursive: true });
    fs.writeFileSync(cfg.pidfile, String(process.pid));
  } catch (e) {
    console.error('cannot write pidfile: ' + e.message);
  }
}

function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  let parsed;
  try {
    parsed = configure(argv, { cwd });
  } catch (e) {
    console.error('Fatal error, can\'t open config file: ' + e.message);
    process.exit(1);
  }
  if (parsed.help) { printHelp(); return; }
  if (parsed.version) { console.log(`xredis-server v=${xredisVersion}`); return; }
  const cfg = parsed.cfg;
  // resolve initial config file if one was supplied positionally
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    try { cfg.configFile = path.resolve(cwd, argv[0]); } catch {}
  }
  if (cfg.logfile) {
    try {
      const f = fs.openSync(path.resolve(cwd, cfg.logfile), 'a');
      const out = fs.createWriteStream('', { fd: f });
      process.stdout.write = (chunk) => { out.write(chunk); return true; };
      process.stderr.write = (chunk) => { out.write(chunk); return true; };
    } catch (e) {
      console.error('cannot open logfile: ' + e.message);
    }
  }
  fs.mkdirSync(cfg.dir, { recursive: true });
  writePid(cfg);

  const server = new RedisServer(cfg);
  const port = cfg.unixsocket ? 0 : (cfg.port || 6379);
  const host = cfg.unixsocket ? undefined : (cfg.bind || '127.0.0.1');

  // Uses the working dir for persistence files.
  server.start({ port, host });

  const shutdown = (sig) => () => {
    server.gracefulShutdown(sig);
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('uncaughtException', (e) => {
    console.error('uncaught exception: ' + e.stack);
  });
  return server;
}

if (require.main === module) {
  main();
}

module.exports = { main, printHelp };
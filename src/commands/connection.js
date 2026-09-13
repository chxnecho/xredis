'use strict';

// Connection commands: PING, ECHO, AUTH, HELLO, QUIT, RESET, CLIENT.

const { toStr, err } = require('../util');
const P = require('../protocol');
const { redisVersion, xredisVersion } = require('../version');

function cmdPing(server, argv, ctx) {
  if (argv.length > 2) throw err("wrong number of arguments for 'ping' command");
  if (argv.length === 2) return ctx.bulk(argv[1]);
  if (server.replState === 'sync' || server.replState === 'connected') return ctx.status('PONG'); // replica internal
  const sub = server.pubsub && server.pubsub.subCount;
  if (sub > 0) return ctx.arr([P.encBulk(Buffer.from('pong', 'latin1')), P.encBulk(Buffer.from('', 'latin1'))]);
  return ctx.status('PONG');
}

function cmdEcho(server, argv, ctx) {
  return ctx.bulk(argv[1]);
}

function cmdQuit(server, argv, ctx) {
  server.state = 'quitting';
  return ctx.ok();
}

function cmdAuth(server, argv, ctx, client) {
  // server.requirepass is the configured password in plaintext.
  const need = server.config.requirepass;
  if (!need) throw err('ERR Client sent AUTH, but no password is set. Did you mean AUTH <username> <password>?');
  const provided = (argv[1] && String(argv[1])) + (argv[2] ? ' ' + String(argv[2]) : '').trim();
  // Redis AUTH [username] password — we accept either the two-arg form (default user)
  // or the single "password" form.
  let ok = false;
  if (argv.length === 2) {
    ok = String(argv[1]) === need;
  } else if (argv.length === 3) {
    ok = String(argv[2]) === need;
  }
  if (!ok) throw err('WRONGPASS invalid username-password pair or user is disabled.');
  if (client) client.authenticated = true;
  server.stats.connectionsAuth++;
  return ctx.ok();
}

// HELLO [protover [AUTH user pass] [SETNAME name]]
function cmdHello(server, argv, ctx, client) {
  const proto = argv.length > 1 ? Number(String(argv[1])) : 2;
  if (proto !== 2 && proto !== 3) throw err('NOPROTO unsupported protocol version');
  for (let i = 2; i < argv.length; i++) {
    const opt = toStr(argv[i]).toUpperCase();
    if (opt === 'AUTH' && i + 2 < argv.length) {
      const user = String(argv[i + 1]);
      const pass = String(argv[i + 2]);
      i += 2;
      const ok = user === 'default' && pass === server.config.requirepass;
      if (!ok) throw err('WRONGPASS invalid username-password pair or user is disabled.');
      if (client) client.authenticated = true;
    } else if (opt === 'SETNAME' && i + 1 < argv.length) {
      const name = String(argv[i + 1]);
      if (/[\s]/.test(name)) throw err('ERR Client names cannot contain spaces, newlines or special characters.');
      if (client) client.name = name;
      i++;
    } else {
      throw err('ERR syntax error in HELLO');
    }
  }
  if (client) client.resp = proto;
  const pairs = [
    P.encBulk(Buffer.from('server', 'latin1')),
    P.encBulk(Buffer.from('redis', 'latin1')),
    P.encBulk(Buffer.from('version', 'latin1')),
    P.encBulk(Buffer.from(redisVersion, 'latin1')),
    P.encBulk(Buffer.from('proto', 'latin1')),
    P.encInt(proto),
    P.encBulk(Buffer.from('id', 'latin1')),
    P.encInt(client ? client.id : 0),
    P.encBulk(Buffer.from('mode', 'latin1')),
    P.encBulk(Buffer.from(server.role === 'master' ? 'master' : 'replica', 'latin1')),
    P.encBulk(Buffer.from('role', 'latin1')),
    P.encBulk(Buffer.from(server.role === 'master' ? 'master' : 'replica', 'latin1')),
    P.encBulk(Buffer.from('modules', 'latin1')),
    P.encArr([]),
  ];
  // RESP3 HELLO returns a map (%); RESP2 returns a flat array.
  if (proto === 3) return P.encMap(pairs);
  return ctx.arr(pairs);
}

function cmdClient(server, argv, ctx, client) {
  const sub = toStr(argv[1]).toUpperCase();
  switch (sub) {
    case 'ID': return ctx.int(client ? client.id : 0);
    case 'SETNAME': {
      const name = String(argv[2]);
      if (!/^[a-zA-Z0-9_\-.]{1,64}$/.test(name)) {
        throw err('ERR Client names cannot contain spaces, newlines or special characters.');
      }
      client.name = name;
      return ctx.ok();
    }
    case 'GETNAME': return ctx.bulk(client && client.name ? Buffer.from(client.name, 'latin1') : null);
    case 'SETINFO': return ctx.ok();
    case 'LIST': {
      const lines = [];
      for (const c of server.clients) {
        const addr = c.socket.remoteAddress + ':' + c.socket.remotePort;
        const fields = [
          `id=${c.id}`, `addr=${addr}`, `name=${c.name || ''}`, `age=0`,
          `idle=0`, `flags=${c.flags || 'N'}`, `db=${server.db.selected}`,
          `sub=${c.subCount || 0}`, `psub=${c.psubCount || 0}`, `multi=${c.inMulti ? 1 : -1}`,
          `qbuf=0`, `qbuf-free=0`, `argv-mem=0`, `obl=0`, `oll=0`, `omem=0`,
          `tot-mem=0`, `events=r`, `cmd=${c.lastCmd || 'NULL'}`,
        ];
        lines.push(fields.join(' '));
      }
      return ctx.bulk(Buffer.from(lines.join('\n'), 'latin1'));
    }
    case 'KILL': {
      const idArg = argv[2];
      let killed = 0;
      if (idArg !== undefined) {
        const id = Number(String(idArg));
        for (let i = server.clients.length - 1; i >= 0; i--) {
          if (server.clients[i].id === id) {
            server.clients[i].socket.destroy();
            killed++;
            break;
          }
        }
        return ctx.int(killed);
      }
      for (let i = server.clients.length - 1; i >= 0; i--) {
        server.clients[i].socket.destroy();
        killed++;
      }
      return ctx.int(killed);
    }
    case 'NO-EVICT': return ctx.ok();
    case 'NO-TOUCH': return ctx.ok();
    default:
      throw err(`ERR unknown subcommand or wrong number of arguments for '${toStr(argv[1])}'. Try CLIENT HELP.`);
  }
}

function cmdReset(server, argv, ctx, client) {
  if (client) {
    client.inMulti = false;
    client.multiQueue = null;
    client.watched = null;
    client.watchedDirty = false;
    client.authenticated = false;
    client.resp = 2;
    client.name = '';
  }
  return ctx.status('RESET');
}

module.exports = {
  cmdPing, cmdEcho, cmdQuit, cmdAuth, cmdHello, cmdClient, cmdReset,
};
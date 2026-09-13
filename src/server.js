'use strict';

// Core TCP server: connection handling, command dispatch, transactions,
// propagation (AOF + replicas), WATCH bookkeeping, heartbeat timers.

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');

const { RespParser, encSimple, encError, encInt, encCmd, encErrLike } = require('./protocol');
const { KeySpace } = require('./store/db');
const { build } = require('./commands/commandtable');
const { makeCtx } = require('./commands/reply');
const { Aof, snapshotFrames } = require('./persistence/aof');
const { ReplBacklog } = require('./persistence/replbacklog');
const rdb = require('./persistence/rdb');
const { toStr, CommandError, WrongTypeError } = require('./util');
const { xredisVersion } = require('./version');
const { LuaVm } = require('./commands/lua');
const { ZSetVal, ListVal } = require('./store/objects');
const P = require('./protocol');

// Sentinel returned by handlers that performed their own out-of-band write.
const NO_REPLY = Symbol('no-reply');

let nextClientId = 1;

function makeVirtualClient() {
  return {
    id: 0,
    socket: { writable: false, write() {}, destroy() {} },
    dbIdx: 0,
    inMulti: false,
    multiQueue: null,
    watched: null,
    watchedDirty: false,
    channels: new Set(),
    patterns: new Set(),
    subCount: 0,
    psubCount: 0,
    name: '',
    authenticated: false,
    lastCmd: 'NULL',
    flags: 'N',
    isVirtual: true,
  };
}

class RedisServer {
  constructor(config, { logger } = {}) {
    this.config = config;
    this.keyspace = new KeySpace(config.databases || 1);
    this.commands = build();
    this.clients = [];
    this.pubsub = { channels: new Map(), patterns: new Map() };
    this.watchedKeys = new Map();
    this.stats = {
      startedAt: Date.now(),
      connectionsReceived: 0,
      commands: 0,
      netInput: 0,
      netOutput: 0,
      rejected: 0,
      pubsubMessages: 0,
      keyspaceHits: 0,
      keyspaceMisses: 0,
      expired: 0,
      evicted: 0,
      lastSave: 0,
      connectionsAuth: 0,
    };
    this.runId = crypto.randomBytes(20).toString('hex');
    this.replid = crypto.randomBytes(20).toString('hex');
    this.replOffset = 0;
    this.role = 'master';
    this.replicas = [];
    this.masterConn = null;
    this.masterLinkState = 'down';
    this.replState = 'none';
    this.configFile = config.configFile || '';
    this.state = 'running';
    this.logger = logger || ((level, msg) => {
      if (level === 'warning' || level === 'notice') {
        console.log(`[xredis ${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`);
      }
    });
    this.aof = new Aof(this, config);
    this.lastPropagatedDb = -1;
    // RDB state.
    this.dirty = 0;                     // writes since last save
    this.dirtyBeforeBgsave = 0;
    this.rdbPath = path.join(config.dir, config.dbfilename || 'dump.rdb');
    this.lastBgsaveStatus = 'ok';
    // Replication state.
    this.replBacklog = new ReplBacklog(config.replBacklogSize || 1024 * 1024);
    this.lastAckTick = 0;
    this.tickers = [];
    this.serverHandle = null;
    this.virtualClient = makeVirtualClient();
  }

  get db() { return this.keyspace.dbs[this.keyspace.selected]; }
  get dbCount() { return this.keyspace.dbs.length; }

  log(level, msg) { this.logger(level, msg); }

  start({ port, host }) {
    // Persistence recovery: AOF takes priority; fall back to RDB.
    const aofFile = path.join(this.config.dir, this.config.appendfilename || 'appendonly.aof');
    if (this.config.appendonly && fs.existsSync(aofFile)) {
      this.aof.load();
    } else {
      const loaded = rdb.loadFromFile(this, this.rdbPath, { tolerateErrors: true });
      if (loaded > 0) this.log('notice', `RDB loaded: ${loaded} keys`);
      else if (loaded === -2) this.log('warning', 'RDB file corrupt, starting with empty keyspace');
    }
    this.serverHandle = net.createServer((socket) => this.handleConnection(socket));
    this.serverHandle.on('error', (e) => {
      this.log('warning', `listen error: ${e.message}`);
      process.exit(1);
    });
    this.serverHandle.listen(port, host, () => {
      this.log('notice', `xredis v${xredisVersion} started, port ${port}`);
      if (this.config.replicaof) {
        this.startReplication(this.config.replicaof.host, this.config.replicaof.port);
      }
    });
    const hz = setInterval(() => this.heartbeat(), 100);
    hz.unref();
    this.tickers.push(hz);
    // Blocking-cmd infrastructure: wait queues keyed by key name.
    this.blocking = { waits: new Map() };   // key -> Set of { client, cmd, argv, deadline, timer }
    // MONITOR observers.
    this.monitors = [];
    // Slow log.
    this.slowlog = [];
    this.slowlogMaxLen = this.config.slowlogMaxLen || 128;
    this.latencyHIST = [];                  // billion-ns bucket histogram (latency monitor)
    return this;
  }

  heartbeat() {
    this.aof.tick();
    if (this.config.activeExpire) {
      this.activeExpire();
    }
    this.maybeRdbSave();
    this.replHeartbeat();
  }

  // Check the `save <sec> <changes>` schedule.
  maybeRdbSave() {
    const schedule = this.config.save || [];
    if (!schedule.length) return;
    const now = Date.now();
    for (const [seconds, changes] of schedule) {
      if (this.dirty >= changes && now - (this.stats.lastSave || this.stats.startedAt) >= seconds * 1000) {
        try {
          this.rdbSave('scheduled');
        } catch (e) {
          this.log('warning', 'scheduled RDB save failed: ' + e.message);
          this.lastBgsaveStatus = 'err: ' + e.message;
        }
        return;
      }
    }
  }

  // Blocking RDB save (SAVE command / schedule / shutdown).
  rdbSave(reason = 'save') {
    const bytes = rdb.saveToFile(this, this.rdbPath);
    this.stats.lastSave = Date.now();
    this.dirty = 0;
    this.lastBgsaveStatus = 'ok';
    this.log('notice', `RDB saved (${reason}): ${bytes} bytes`);
    return bytes;
  }

  // Replication maintenance: ask replicas for their offsets once a second
  // (Redis GETACK heartbeat: the replica answers with REPLCONF ACK <offset>).
  replHeartbeat() {
    this.lastAckTick++;
    if (this.lastAckTick < 10 || this.replicas.length === 0) return;
    this.lastAckTick = 0;
    const frame = encCmd(['REPLCONF', 'GETACK', '*']);
    for (const r of this.replicas) {
      if (r.socket && r.socket.writable) r.socket.write(frame);
    }
  }

  activeExpire() {
    const now = Date.now();
    for (const db of this.keyspace.all()) {
      this.stats.expired += db.activeExpire(now, 20);
    }
  }
/* ---------------------------- connection handling ----------------------- */

  handleConnection(socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, (this.config['tcp-keepalive'] || 300) * 1000);
    const client = {
      id: nextClientId++,
      socket,
      parser: new RespParser({ maxBulk: this.config['proto-max-bulk-len'] }),
      dbIdx: 0,
      inMulti: false,
      multiQueue: null,
      watched: null,
      watchedDirty: false,
      channels: new Set(),
      patterns: new Set(),
      subCount: 0,
      psubCount: 0,
      name: '',
      authenticated: false,
      lastCmd: 'NULL',
      flags: 'N',
      lastActive: Date.now(),
    };
    this.stats.connectionsReceived++;
    if (this.clients.length >= this.config.maxclients) {
      this.stats.rejected++;
      socket.write(encError('ERR max number of clients reached'));
      socket.destroy();
      return;
    }
    this.clients.push(client);

    socket.on('data', (chunk) => {
      this.stats.netInput += chunk.length;
      try {
        client.parser.feed(chunk);
        let values;
        try {
          values = client.parser.parse();
        } catch (e) {
          if (e.xrProtocol) {
            socket.write(encError(e.message));
            socket.destroy();
            return;
          }
          throw e;
        }
        if (values.length === 0) return;
        // Coalesce all replies produced by this batch of pipelined commands
        // into a single socket write.
        const wasCollecting = client.outBufs !== null && client.outBufs !== undefined;
        if (!wasCollecting) client.outBufs = [];
        for (const val of values) {
          if (!val || val.t !== '*') {
            client.outBufs.push(encError('ERR Protocol error: expected array, got ' + (val && val.t)));
            socket.write(Buffer.concat(client.outBufs));
            client.outBufs = null;
            socket.destroy();
            return;
          }
          const argv = val.a.map((x) => x.b);
          this.dispatch(client, argv);
        }
        if (client.outBufs.length > 0) {
          const out = client.outBufs.length === 1 ? client.outBufs[0] : Buffer.concat(client.outBufs);
          client.socket.write(out);
        }
        client.outBufs = null;
      } catch (e) {
        this.log('warning', `client ${client.id} error: ${e.message}`);
        socket.destroy();
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.removeClient(client));
    socket.on('timeout', () => {
      if (this.config.timeout > 0) socket.destroy();
    });
    if (this.config.timeout > 0) socket.setTimeout(this.config.timeout * 1000);
  }

  removeClient(client) {
    const idx = this.clients.indexOf(client);
    if (idx !== -1) this.clients.splice(idx, 1);
    if (client.subCount || client.psubCount) {
      for (const chan of client.channels) {
        const set = this.pubsub.channels.get(chan);
        if (set) { set.delete(client); if (set.size === 0) this.pubsub.channels.delete(chan); }
      }
      for (const pat of client.patterns) {
        const set = this.pubsub.patterns.get(pat);
        if (set) { set.delete(client); if (set.size === 0) this.pubsub.patterns.delete(pat); }
      }
    }
    this.unwatchAll(client);
  }

  unwatchAll(client) {
    if (!client.watched) return;
    for (const key of client.watched) {
      const set = this.watchedKeys.get(key);
      if (set) { set.delete(client); if (set.size === 0) this.watchedKeys.delete(key); }
    }
    client.watched = null;
  }

  touchKeys(argv, cmd) {
    if (this.watchedKeys.size === 0) return;
    const touched = new Set();
    if (cmd && cmd.firstKey >= 1) {
      const lastKey = (cmd.lastKey < 0) ? argv.length - 1 : Math.min(cmd.lastKey, argv.length - 1);
      for (let i = cmd.firstKey; i <= lastKey; i += (cmd.keyStep || 1)) {
        if (i < argv.length) touched.add(toStr(argv[i]));
      }
    }
    for (const key of touched) {
      const watchers = this.watchedKeys.get(key);
      if (!watchers) continue;
      for (const w of watchers) w.watchedDirty = true;
    }
  }

  /* ------------------------------ dispatch -------------------------------- */

  dispatch(client, argv, opts = {}) {
    const nameBuf = argv[0];
    if (!nameBuf) return;
    const name = toStr(nameBuf).toLowerCase();
    const cmd = this.commands.get(name);

    if (!cmd) {
      this.sendReply(client, encError(`ERR unknown command '${name}', with args beginning with: ${argv.slice(1, 5).map((a) => toStr(a)).join(', ')}`));
      this.stats.commands++;
      return;
    }

    if (client.inMulti && !['multi', 'exec', 'discard', 'watch', 'unwatch', 'reset', 'quit'].includes(name) && !opts.fromAof && !opts.fromMaster) {
      try {
        cmd.checkArity(argv);
      } catch (e) {
        this.abortMulti(client);
        this.sendReply(client, encErrLike(e));
        return;
      }
      client.multiQueue.push({ argv, cmd });
      this.sendReply(client, encSimple('QUEUED'));
      return;
    }

    let reply;
    try {
      reply = this.executeNamed(client, name, cmd, argv, opts);
    } catch (e) {
      reply = this.replyForError(e);
    }
    if (reply === NO_REPLY) return; // handled out-of-band
    if (reply === undefined) reply = encError('ERR internal error: command returned no reply');
    if (reply && !opts.dryRun) this.sendReply(client, reply);
    this.stats.commands++;
    client.lastCmd = name;
    client.lastActive = Date.now();
  }

  // Route a reply through the per-batch coalescing buffer when one is active
  // (pipelining), otherwise write immediately.
  sendReply(client, reply) {
    if (client.outBufs) {
      client.outBufs.push(reply);
      return;
    }
    client.socket.write(reply);
  }

  executeNamed(client, name, cmd, argv, opts = {}) {
    if (this.config.requirepass && !client.authenticated && !['auth', 'hello', 'quit', 'reset'].includes(name) && !opts.fromAof && !opts.fromMaster) {
      throw new CommandError('Authentication required.');
    }
    cmd.checkArity(argv);
    if (cmd.write && this.role !== 'master' && !opts.fromMaster && !opts.fromAof) {
      throw new CommandError('You can\'t write against a read only replica.', 'READONLY');
    }
    this.keyspace.selected = client.dbIdx;
    const ctx = makeCtx(client);
    ctx.errLike = (s) => encError(s);
    const reply = cmd.handler(this, argv, ctx, client);
    // Propagation policy: only commands that actually took effect are written
    // to the AOF / replicas. Handlers signal this via ctx:
    //   ctx.noPropagate — the command was a no-op (e.g. SET NX/XX failed);
    //     replaying it later on the same state is safe, but canonicalize()
    //     strips NX/XX, so a failed conditional write must NOT be propagated.
    //   ctx.effectArgv  — deterministic replacement commands (e.g. SPOP is
    //     random, so we propagate the actual effect as `SREM key members...`).
    if (cmd.write && !opts.fromAof && !opts.fromMaster && !ctx.noPropagate) {
      this.propagate(cmd, argv, client, ctx);
    }
    if (cmd.write && !ctx.noPropagate && this.watchedKeys.size > 0) {
      this.touchKeys(argv, cmd);
    }
    return reply;
  }

  propagate(cmd, argv, client, ctx) {
    // When the client lives on a different database than the last propagated
    // command, emit an explicit SELECT so replicas/AOF replay land in the
    // right keyspace.
    const dbIdx = client ? client.dbIdx : 0;
    if (dbIdx !== this.lastPropagatedDb) {
      const sel = encCmd(['SELECT', String(dbIdx)]);
      this.aof.feed(sel);
      this.feedReplicas(sel);
      this.lastPropagatedDb = dbIdx;
    }
    const effects = (ctx && ctx.effectArgv && ctx.effectArgv.length) ? ctx.effectArgv : [argv];
    for (const av of effects) {
      const name = toStr(av[0]).toLowerCase();
      const canon = canonicalize(this.commands.get(name) || { name }, av);
      if (!canon) continue;
      this.aof.feed(canon);
      this.feedReplicas(canon);
    }
    this.dirty++;
  }

  // Send a canonical command to the backlog and every online replica.
  feedReplicas(canon) {
    const frame = encCmd(canon);
    this.replBacklog.feed(frame);
    this.replOffset = this.replBacklog.masterOffset;
    for (let i = this.replicas.length - 1; i >= 0; i--) {
      const r = this.replicas[i];
      if (r.socket && r.socket.writable) r.socket.write(frame);
    }
  }

  replyForError(e) {
    if (e instanceof WrongTypeError) return encError('WRONGTYPE Operation against a key holding the wrong kind of value');
    if (e instanceof CommandError) return encError(e.xrCode ? `${e.xrCode} ${e.message}` : `ERR ${e.message}`);
    if (e && e.xrCode) return encError(`${e.xrCode} ${e.message}`);
    const msg = (e && e.message) ? e.message : String(e);
    this.log('warning', `unhandled error: ${msg}\n${e && e.stack ? e.stack : ''}`);
    return encError('ERR ' + msg);
  }

  execRaw(argv, opts = {}) {
    const vc = this.virtualClient;
    const name = toStr(argv[0]).toLowerCase();
    const cmd = this.commands.get(name);
    if (!cmd) return null;
    try {
      return this.executeNamed(vc, name, cmd, argv, { fromAof: true, ...opts });
    } catch (e) {
      this.log('warning', `execRaw ${name} failed: ${e.message}`);
      return null;
    }
  }

  /* ------------------------------ transactions --------------------------- */

  execQueue(client, queue) {
    this.unwatchAll(client);
    if (client.watchedDirty) {
      client.watchedDirty = false;
      return encError('EXECABORT Transaction discarded because of previous errors.');
    }
    const parts = [];
    let ok = true;
    client.inMulti = false;
    for (const item of queue) {
      try {
        const r = this.executeNamed(client, item.cmd.name, item.cmd, item.argv);
        parts.push(r === undefined ? encError('ERR no reply') : r);
      } catch (e) {
        parts.push(this.replyForError(e));
        ok = false;
        break;
      }
    }
    client.multiQueue = null;
    if (!ok) this.abortMulti(client);
    const head = Buffer.from(`*${parts.length}\r\n`, 'latin1');
    return parts.length ? Buffer.concat([head, ...parts]) : head;
  }

  abortMulti(client) {
    client.inMulti = false;
    client.multiQueue = null;
    this.unwatchAll(client);
  }

  /* ------------------------------ replication ---------------------------- */

  handleSyncRequest(rlink) {
    const frames = snapshotFrames(this);
    const payload = Buffer.concat(frames);
    const head = Buffer.from(`+FULLRESYNC ${this.replid} ${this.replOffset}\r\n`, 'latin1');
    const bulk = Buffer.concat([
      Buffer.from(`$${payload.length}\r\n`, 'latin1'),
      payload,
      Buffer.from('\r\n', 'latin1'),
    ]);
    rlink.online = true;
    rlink.acked = this.replOffset;
    this.replicas.push(rlink);
    rlink.socket.write(head);
    rlink.socket.write(bulk);
    this.log('notice', `replica ${rlink.host}:${rlink.port} full-synced (${payload.length} bytes)`);
  }

  // PSYNC <replid> <offset> — the real Redis handshake. Partial resync when
  // the replica's offset is still inside the backlog.
  handlePsyncRequest(rlink, replid, offset) {
    const canPartial = replid === this.replid && this.replBacklog.canPartialSync(offset);
    if (canPartial) {
      const head = Buffer.from(`+CONTINUE ${this.replid}\r\n`, 'latin1');
      const back = this.replBacklog.slice(offset);
      rlink.online = true;
      rlink.acked = offset;
      this.replicas.push(rlink);
      rlink.socket.write(head);
      if (back && back.length) rlink.socket.write(back);
      this.log('notice', `replica ${rlink.host}:${rlink.port} partial resync from offset ${offset} (${back ? back.length : 0} bytes)`);
      return;
    }
    this.handleSyncRequest(rlink);
  }

  startReplication(host, port) {
    this.role = 'replica';
    this.replState = 'connecting';
    this.masterLinkState = 'connecting';
    this.log('notice', `replica: connecting to ${host}:${port}`);
    const sock = net.createConnection({ host, port });
    this.masterConn = sock;
    let buf = Buffer.alloc(0);
    sock.on('connect', () => {
      sock.write(encCmd(['PING']));
      sock.write(encCmd(['REPLCONF', 'listening-port', String(this.config.port || 0)]));
      sock.write(encCmd(['REPLCONF', 'capa', 'psync2']));
      // Attempt a partial resync if we remember the master's identity.
      const lastId = this.masterReplid || '?';
      const lastOffset = this.masterOffset || -1;
      sock.write(encCmd(['PSYNC', lastId, String(lastOffset)]));
    });
    sock.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        const parser = new RespParser({ maxBulk: 2 * 1024 * 1024 * 1024 });
        parser.feed(buf);
        const vals = parser.parse();
        buf = parser.buf;
        for (const v of vals) this.handleMasterReply(v, sock);
      } catch (e) {
        this.log('warning', 'replica protocol error, reconnecting: ' + e.message);
        sock.destroy();
      }
    });
    sock.on('error', (e) => {
      this.masterLinkState = 'down';
      this.log('warning', `replication error: ${e.message}`);
    });
    sock.on('close', () => {
      this.masterLinkState = 'down';
      if (this.state === 'running') {
        this.log('notice', 'replica: reconnecting in 1s');
        setTimeout(() => this.startReplication(host, port), 1000);
      }
    });
  }

  stopReplication(role = 'master') {
    this.role = role;
    this.replState = 'none';
    this.masterLinkState = 'down';
    this.masterReplid = null;
    this.masterOffset = 0;
    this.log('notice', `replica mode disabled, now ${role}`);
    try { if (this.masterConn) this.masterConn.destroy(); } catch {}
    this.masterConn = null;
    // Replicas we host (as upstream) are kept.
  }

  handleMasterReply(v, sock) {
    if (v.t === '+') {
      if (v.s.startsWith('FULLRESYNC')) {
        // +FULLRESYNC <replid> <offset>
        const parts = v.s.split(/\s+/);
        this.masterReplid = parts[1] || '0';
        this.masterOffset = Number(parts[2]) || 0;
        this.expectBulk = true;
        return;
      }
      if (v.s.startsWith('CONTINUE')) {
        // Partial resync accepted: master replays the backlog from our offset.
        const parts = v.s.split(/\s+/);
        this.masterReplid = parts[1] || this.masterReplid;
        this.masterLinkState = 'up';
        this.replState = 'online';
        this.log('notice', `replica online after partial resync (offset ${this.masterOffset})`);
        return;
      }
      return; // PONG / OK etc
    }
    if (v.t === '$') {
      if (this.expectBulk) {
        this.expectBulk = false;
        this.applySnapshot(v.b);
        this.masterLinkState = 'up';
        this.replState = 'online';
        this.log('notice', `replica online after full sync (offset ${this.masterOffset})`);
        return;
      }
      return;
    }
    if (v.t === '*') {
      if (!v.a) return; // *-1 null array (e.g. propagated nil) — nothing to apply
      const argv = v.a.map((x) => x && x.b);
      if (argv.some((a) => a === undefined || a === null)) return; // non-bulk element (e.g. int reply) — ignore
      const name = toStr(argv[0]).toLowerCase();
      // Master asks us to report our consumption offset.
      if (name === 'replconf' && argv[1] && toStr(argv[1]).toLowerCase() === 'getack') {
        sock.write(encCmd(['REPLCONF', 'ACK', String(this.masterOffset || 0)]));
        return;
      }
      if (name === 'replconf' && argv[1] && toStr(argv[1]).toLowerCase() === 'ack') {
        // A stale ACK heartbeat echoed back; not a command to apply.
        return;
      }
      this.masterOffset += encCmd(argv).length;
      this.execRaw(argv, { fromMaster: true });
    }
  }

  applySnapshot(bulk) {
    const parser = new RespParser({ maxBulk: 2 * 1024 * 1024 * 1024 });
    parser.feed(bulk);
    let frames = [];
    try { frames = parser.parse(); } catch (e) {
      this.log('warning', 'snapshot parse failed: ' + e.message);
      return;
    }
    let n = 0;
    for (const frame of frames) {
      if (!frame || frame.t !== '*' || !frame.a) continue;
      const argv = frame.a.map((x) => x && x.b);
      if (argv.some((a) => a === undefined || a === null)) continue;
      this.execRaw(argv, { fromMaster: true });
      n++;
    }
    this.log('notice', `full sync applied: ${n} frames`);
  }

  /* ------------------------------- shutdown ------------------------------ */

  gracefulShutdown(reason) {
    this.log('notice', `shutting down (${reason})`);
    this.aof.flush();
    this.aof.fsync();
    this.aof.close();
    if (!this.config.appendonly) {
      try { this.rdbSave('shutdown'); } catch (e) { this.log('warning', 'RDB save on shutdown failed: ' + e.message); }
    }
    try { if (this.serverHandle) this.serverHandle.close(); } catch {}
    if (this.config.pidfile) { try { fs.unlinkSync(this.config.pidfile); } catch {} }
    setTimeout(() => process.exit(0), 150).unref();
  }
}

// Convert a write command into its canonical replay-safe form for AOF /
// replication propagation. For SET:
//   - relative/absolute expiry options fold into PXAT (absolute wall clock),
//   - NX/XX/KEEPTTL are preserved: they decide whether/how the write applies,
//     so replaying without them would diverge from the master's state,
//   - GET is dropped (read-only side effect, no replay impact).
// Commands that took no effect (ctx.noPropagate) never reach this function.
function canonicalize(cmd, argv) {
  if (cmd.name !== 'set') {
    return argv.map((a) => (Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'latin1')));
  }
  const out = [Buffer.from('SET', 'latin1'), argv[1], argv[2]];
  for (let i = 3; i < argv.length; i++) {
    const opt = toStr(argv[i]).toUpperCase();
    if (opt === 'EX' || opt === 'PX' || opt === 'EXAT' || opt === 'PXAT') {
      if (i + 1 >= argv.length) break;
      const v = Number(toStr(argv[i + 1]));
      i++;
      let abs;
      if (opt === 'EX') abs = Date.now() + v * 1000;
      else if (opt === 'PX') abs = Date.now() + v;
      else if (opt === 'EXAT') abs = v * 1000;
      else abs = v;
      if (abs <= Date.now()) {
        // Expired on write: the master deleted the key, so persist a DEL.
        return [Buffer.from('DEL', 'latin1'), argv[1]];
      }
      out.push(Buffer.from('PXAT', 'latin1'), Buffer.from(String(Math.floor(abs)), 'latin1'));
    } else if (opt === 'NX' || opt === 'XX' || opt === 'KEEPTTL') {
      out.push(Buffer.from(opt, 'latin1'));
    }
    // GET and unknown/invalid options are read-only or arity-checked away.
  }
  return out;
}

module.exports = { RedisServer, makeVirtualClient, canonicalize, NO_REPLY };
'use strict';

// The command table. Each entry carries metadata (arity, flags, argument
// positions that are keys) and the handler. This table powers validation,
// AOF propagation, replication and the COMMAND introspection command.

const { Command } = require('./registry');
const S = require('./string');
const KS = require('./keyspace');
const H = require('./hash');
const L = require('./list');
const SET = require('./set');
const Z = require('./zset');
const CONN = require('./connection');
const PS = require('./pubsub');
const TX = require('./transactions');
const INFO = require('./serverinfo');
const ADMIN = require('./admin');
const LUA = require('./lua');

const flags = {
  write: ['write'],
  ro: ['readonly'],
  admin: ['admin'],
  denyoom: ['denyoom'],
  pubsub: ['pubsub'],
};

function build() {
  const cmds = new Map();
  const reg = (name, arity, fl, firstKey, lastKey, handler, opts = {}) => {
    const c = new Command(name, {
      arity, flags: fl, firstKey, lastKey, keyStep: opts.keyStep || 1, handler,
    });
    cmds.set(c.name, c);
  };

  /* ------------------------------ connection ------------------------------ */
  reg('ping', -1, flags.ro, -1, -1, CONN.cmdPing);
  reg('echo', 2, flags.ro, -1, -1, CONN.cmdEcho);
  reg('quit', -1, flags.ro, -1, -1, CONN.cmdQuit);
  reg('auth', -1, flags.ro, -1, -1, CONN.cmdAuth);
  reg('hello', -1, flags.ro, -1, -1, CONN.cmdHello);
  reg('reset', 1, flags.ro, -1, -1, CONN.cmdReset);
  reg('client', -2, flags.admin, -1, -1, CONN.cmdClient);
  reg('select', 2, flags.ro, -1, -1, KS.cmdSelect);

  /* -------------------------------- strings ------------------------------ */
  reg('set', -3, flags.write, 1, 1, S.cmdSet);
  reg('get', 2, flags.ro, 1, 1, S.cmdGet);
  reg('setnx', 3, flags.write, 1, 1, S.cmdSetNX);
  reg('setex', 4, flags.write, 1, 1, S.cmdSetEX);
  reg('psetex', 4, flags.write, 1, 1, S.cmdPSetEX);
  reg('getset', 3, flags.write, 1, 1, S.cmdGetSet);
  reg('getdel', 2, flags.write, 1, 1, S.cmdGetDel);
  reg('getex', -2, flags.write, 1, 1, S.cmdGetEx);
  reg('append', 3, flags.write, 1, 1, S.cmdAppend);
  reg('strlen', 2, flags.ro, 1, 1, S.cmdStrlen);
  reg('incr', 2, flags.write, 1, 1, S.cmdIncr);
  reg('decr', 2, flags.write, 1, 1, S.cmdDecr);
  reg('incrby', 3, flags.write, 1, 1, S.cmdIncrBy);
  reg('decrby', 3, flags.write, 1, 1, S.cmdDecrBy);
  reg('incrbyfloat', 3, flags.write, 1, 1, S.cmdIncrByFloat);
  reg('mget', -2, flags.ro, 1, -1, S.cmdMGet);
  reg('mset', -3, flags.write, 1, -1, S.cmdMSet, { keyStep: 2 });
  reg('msetnx', -3, flags.write, 1, -1, S.cmdMSetNX, { keyStep: 2 });
  reg('getrange', 4, flags.ro, 1, 1, S.cmdGetRange);
  reg('substr', 4, flags.ro, 1, 1, S.cmdGetRange);
  reg('setrange', 4, flags.write, 1, 1, S.cmdSetRange);
  reg('setbit', 4, flags.write, 1, 1, S.cmdSetBit);
  reg('getbit', 3, flags.ro, 1, 1, S.cmdGetBit);
  reg('bitcount', -2, flags.ro, 1, 1, S.cmdBitCount);
  reg('bitpos', -3, flags.ro, 1, 1, S.cmdBitPos);

  /* ------------------------------- keyspace ------------------------------ */
  reg('del', -2, flags.write, 1, -1, KS.cmdDel);
  reg('unlink', -2, flags.write, 1, -1, KS.cmdUnlink);
  reg('exists', -2, flags.ro, 1, -1, KS.cmdExists);
  reg('expire', -3, flags.write, 1, 1, KS.cmdExpire);
  reg('pexpire', -3, flags.write, 1, 1, KS.cmdPExpire);
  reg('expireat', -3, flags.write, 1, 1, KS.cmdExpireAt);
  reg('pexpireat', -3, flags.write, 1, 1, KS.cmdPExpireAt);
  reg('ttl', 2, flags.ro, 1, 1, KS.cmdTTL);
  reg('pttl', 2, flags.ro, 1, 1, KS.cmdPTTL);
  reg('persist', 2, flags.write, 1, 1, KS.cmdPersist);
  reg('type', 2, flags.ro, 1, 1, KS.cmdType);
  reg('dbsize', 1, flags.ro, -1, -1, INFO.cmdDbsize);
  reg('flushdb', -1, flags.write, -1, -1, KS.cmdFlushDb);
  reg('flushall', -1, flags.write, -1, -1, KS.cmdFlushAll);
  reg('keys', 2, flags.ro, 1, 1, KS.cmdKeys);
  reg('scan', -2, flags.ro, 1, 1, KS.cmdScan);
  reg('randomkey', 1, flags.ro, -1, -1, KS.cmdRandomKey);
  reg('rename', 3, flags.write, 1, 2, KS.cmdRename);
  reg('renamenx', 3, flags.write, 1, 2, KS.cmdRenameNX);
  reg('touch', -2, flags.ro, 1, -1, KS.cmdTouch);
  reg('copy', -3, flags.write, 1, 2, KS.cmdCopy);

  /* --------------------------------- hash -------------------------------- */
  reg('hset', -4, flags.write, 1, 1, H.cmdHSet);
  reg('hsetnx', 4, flags.write, 1, 1, H.cmdHSetNX);
  reg('hget', 3, flags.ro, 1, 1, H.cmdHGet);
  reg('hmget', -3, flags.ro, 1, 1, H.cmdHMGet);
  reg('hdel', -3, flags.write, 1, 1, H.cmdHDel);
  reg('hlen', 2, flags.ro, 1, 1, H.cmdHLen);
  reg('hexists', 3, flags.ro, 1, 1, H.cmdHExists);
  reg('hkeys', 2, flags.ro, 1, 1, H.cmdHKeys);
  reg('hvals', 2, flags.ro, 1, 1, H.cmdHVals);
  reg('hgetall', 2, flags.ro, 1, 1, H.cmdHGetAll);
  reg('hincrby', 4, flags.write, 1, 1, H.cmdHIncrBy);
  reg('hincrbyfloat', 4, flags.write, 1, 1, H.cmdHIncrByFloat);
  reg('hscan', -3, flags.ro, 1, 1, H.hashScan);
  reg('hstrlen', 3, flags.ro, 1, 1, H.cmdHStrlen);
  reg('hrandfield', -2, flags.ro, 1, 1, H.cmdHRandField);

  /* --------------------------------- list -------------------------------- */
  reg('lpush', -3, flags.write, 1, 1, L.cmdLPush);
  reg('rpush', -3, flags.write, 1, 1, L.cmdRPush);
  reg('lpushx', -3, flags.write, 1, 1, L.cmdLPushX);
  reg('rpushx', -3, flags.write, 1, 1, L.cmdRPushX);
  reg('lpop', -2, flags.write, 1, 1, L.cmdLPop);
  reg('rpop', -2, flags.write, 1, 1, L.cmdRPop);
  reg('llen', 2, flags.ro, 1, 1, L.cmdLLen);
  reg('lrange', 4, flags.ro, 1, 1, L.cmdLRange);
  reg('lindex', 3, flags.ro, 1, 1, L.cmdLIndex);
  reg('lset', 4, flags.write, 1, 1, L.cmdLSet);
  reg('linsert', 5, flags.write, 1, 1, L.cmdLInsert);
  reg('lrem', 4, flags.write, 1, 1, L.cmdLRem);
  reg('ltrim', 4, flags.write, 1, 1, L.cmdLTrim);
  reg('lmove', 5, flags.write, 1, 2, L.cmdLMove);

  /* ---------------------------------- set -------------------------------- */
  reg('sadd', -3, flags.write, 1, 1, SET.cmdSAdd);
  reg('srem', -3, flags.write, 1, 1, SET.cmdSRem);
  reg('sismember', 3, flags.ro, 1, 1, SET.cmdSIsMember);
  reg('smismember', -3, flags.ro, 1, 1, SET.cmdSMIsMember);
  reg('scard', 2, flags.ro, 1, 1, SET.cmdSCard);
  reg('smembers', 2, flags.ro, 1, 1, SET.cmdSMembers);
  reg('spop', -2, flags.write, 1, 1, SET.cmdSPop);
  reg('srandmember', -2, flags.ro, 1, 1, SET.cmdSRandMember);
  reg('smove', 4, flags.write, 1, 2, SET.cmdSMove);
  reg('sinter', -2, flags.ro, 1, -1, SET.cmdSInter);
  reg('sunion', -2, flags.ro, 1, -1, SET.cmdSUnion);
  reg('sdiff', -2, flags.ro, 1, -1, SET.cmdSDiff);
  reg('sinterstore', -3, flags.write, 1, -1, SET.cmdSInterStore);
  reg('sunionstore', -3, flags.write, 1, -1, SET.cmdSUnionStore);
  reg('sdiffstore', -3, flags.write, 1, -1, SET.cmdSDiffStore);

  /* ---------------------------------- zset ------------------------------- */
  reg('zadd', -4, flags.write, 1, 1, Z.cmdZAdd);
  reg('zscore', 3, flags.ro, 1, 1, Z.cmdZScore);
  reg('zmscore', -3, flags.ro, 1, 1, Z.cmdZMScore);
  reg('zrem', -3, flags.write, 1, 1, Z.cmdZRem);
  reg('zcard', 2, flags.ro, 1, 1, Z.cmdZCard);
  reg('zincrby', 4, flags.write, 1, 1, Z.cmdZIncrBy);
  reg('zrange', -4, flags.ro, 1, 1, Z.cmdZRange);
  reg('zrevrange', -4, flags.ro, 1, 1, Z.cmdZRevRange);
  reg('zrangebyscore', -4, flags.ro, 1, 1, Z.cmdZRangeByScore);
  reg('zrevrangebyscore', -4, flags.ro, 1, 1, Z.cmdZRevRangeByScore);
  reg('zrangebylex', -4, flags.ro, 1, 1, Z.cmdZRangeByLex);
  reg('zrevrangebylex', -4, flags.ro, 1, 1, Z.cmdZRevRangeByLex);
  reg('zrank', -3, flags.ro, 1, 1, Z.cmdZRank);
  reg('zrevrank', -3, flags.ro, 1, 1, Z.cmdZRevRank);
  reg('zinterstore', -4, flags.write, 1, 1, Z.cmdZInterStore);
  reg('zunionstore', -4, flags.write, 1, 1, Z.cmdZUnionStore);
  reg('zremrangebyrank', 4, flags.write, 1, 1, Z.cmdZRemRangeByRank);
  reg('zremrangebyscore', 4, flags.write, 1, 1, Z.cmdZRemRangeByScore);
  reg('zpopmin', -2, flags.write, 1, 1, Z.cmdZPop);
  reg('zpopmax', -2, flags.write, 1, 1, Z.cmdZPop);
  reg('zcount', 4, flags.ro, 1, 1, Z.cmdZCount);
  reg('zlexcount', 4, flags.ro, 1, 1, Z.cmdZLexCount);
  reg('zremrangebylex', 4, flags.write, 1, 1, Z.cmdZRemRangeByLex);

  /* ------------------------------- transactions -------------------------- */
  reg('multi', 1, flags.write, -1, -1, TX.cmdMulti);
  reg('exec', 1, flags.write, -1, -1, TX.cmdExec);
  reg('discard', 1, flags.write, -1, -1, TX.cmdDiscard);
  reg('watch', -2, flags.write, -1, -1, TX.cmdWatch);
  reg('unwatch', 1, flags.write, -1, -1, TX.cmdUnwatch);

  /* --------------------------------- pubsub ------------------------------ */
  reg('subscribe', -2, flags.pubsub, -1, -1, PS.cmdSubscribe);
  reg('unsubscribe', -1, flags.pubsub, -1, -1, PS.cmdUnsubscribe);
  reg('psubscribe', -2, flags.pubsub, -1, -1, PS.cmdPSubscribe);
  reg('punsubscribe', -1, flags.pubsub, -1, -1, PS.cmdPUnsubscribe);
  reg('publish', 3, flags.ro, -1, -1, PS.cmdPublish);
  reg('pubsub', -2, flags.ro, -1, -1, PS.cmdPubSub);

  /* --------------------------------- scripting ---------------------------- */
  // EVAL/EVALSHA are registered as write commands; the dispatcher propagates
  // the script itself, so writes performed via redis.call() inside the script
  // are applied (not re-propagated) on replicas and AOF replay.
  reg('eval', -3, flags.write, -1, -1, LUA.cmdEval);
  reg('evalsha', -3, flags.write, -1, -1, LUA.cmdEvalSha);
  reg('script', -2, flags.admin, -1, -1, LUA.cmdScript);

  /* ------------------------------ server/admin ---------------------------- */
  reg('info', -1, flags.ro, -1, -1, INFO.cmdInfo);
  reg('config', -2, flags.admin, -1, -1, INFO.cmdConfig);
  reg('time', 1, flags.ro, -1, -1, INFO.cmdTime);
  reg('command', -1, flags.ro, -1, -1, INFO.cmdCommand);
  reg('lastsave', 1, flags.ro, -1, -1, INFO.cmdLastSave);
  reg('save', 1, flags.admin, -1, -1, ADMIN.cmdSave);
  reg('bgsave', -1, flags.admin, -1, -1, ADMIN.cmdBgSave);
  reg('shutdown', -1, flags.admin, -1, -1, ADMIN.cmdShutdown);
  reg('debug', -2, flags.admin, -1, -1, ADMIN.cmdDebug);
  reg('memory', -2, flags.ro, -1, -1, ADMIN.cmdMemory);
  reg('object', -2, flags.ro, -1, -1, ADMIN.cmdObject);
  reg('role', 1, flags.ro, -1, -1, ADMIN.cmdRole);
  reg('slowlog', -2, flags.admin, -1, -1, ADMIN.cmdSlowlog);

  /* ------------------------------ replication ---------------------------- */
  reg('replicaof', 3, flags.admin, -1, -1, ADMIN.cmdReplicaOf);
  reg('slaveof', 3, flags.admin, -1, -1, ADMIN.cmdReplicaOf);
  reg('psync', 3, flags.admin, -1, -1, ADMIN.cmdPsync);
  reg('sync', 1, flags.admin, -1, -1, ADMIN.cmdXReplSync);
  reg('xreplsync', 1, flags.admin, -1, -1, ADMIN.cmdXReplSync);
  reg('replconf', -3, flags.admin, -1, -1, ADMIN.cmdReplConf);
  reg('wait', 3, flags.admin, -1, -1, ADMIN.cmdWait);

  return cmds;
}

module.exports = { build };
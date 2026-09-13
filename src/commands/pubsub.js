'use strict';

// Pub/Sub: SUBSCRIBE / UNSUBSCRIBE / PSUBSCRIBE / PUNSUBSCRIBE / PUBLISH /
// PUBSUB CHANNELS|NUMSUB|NUMPAT.
//
// Wire frames:
//   subscribe:  *3 <n:$9 subscribe> <channel> <count>
//   message:    *3 <$7 message> <channel> <payload>
//   pmessage:   *4 <$8 pmessage> <pattern> <channel> <payload>

const { toStr, globMatch, err } = require('../util');
const P = require('../protocol');

const B_SUB = 'latin1';

function subFrame(kind, label, chan, count) {
  return Buffer.concat([
    Buffer.from(`*3\r\n$${label.length}\r\n${label}\r\n`, B_SUB),
    P.encBulk(Buffer.from(chan === null ? '' : chan, B_SUB)),
    P.encInt(count),
  ]);
}

function psubFrame(label, pattern, count) {
  return Buffer.concat([
    Buffer.from(`*3\r\n$${label.length}\r\n${label}\r\n`, B_SUB),
    P.encBulk(Buffer.from(pattern === null ? '' : pattern, B_SUB)),
    P.encInt(count),
  ]);
}

function cmdSubscribe(server, argv, ctx, client) {
  const ps = server.pubsub;
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const chan = toStr(argv[i]);
    if (!ps.channels.has(chan)) ps.channels.set(chan, new Set());
    ps.channels.get(chan).add(client);
    client.channels.add(chan);
    client.subCount = client.channels.size;
    out.push(subFrame('subscribe', 'subscribe', chan, client.subCount + client.psubCount));
  }
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

function cmdUnsubscribe(server, argv, ctx, client) {
  const ps = server.pubsub;
  const targets = argv.length > 1
    ? argv.slice(1).map((a) => toStr(a))
    : Array.from(client.channels);
  const out = [];
  for (const chan of targets) {
    const set = ps.channels.get(chan);
    if (set) { set.delete(client); if (set.size === 0) ps.channels.delete(chan); }
    client.channels.delete(chan);
    client.subCount = client.channels.size;
    out.push(subFrame('unsubscribe', 'unsubscribe', chan, client.subCount + client.psubCount));
  }
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

function cmdPSubscribe(server, argv, ctx, client) {
  const ps = server.pubsub;
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const pat = toStr(argv[i]);
    if (!ps.patterns.has(pat)) ps.patterns.set(pat, new Set());
    ps.patterns.get(pat).add(client);
    client.patterns.add(pat);
    client.psubCount = client.patterns.size;
    out.push(psubFrame('psubscribe', pat, client.subCount + client.psubCount));
  }
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

function cmdPUnsubscribe(server, argv, ctx, client) {
  const ps = server.pubsub;
  const targets = argv.length > 1
    ? argv.slice(1).map((a) => toStr(a))
    : Array.from(client.patterns);
  const out = [];
  for (const pat of targets) {
    const set = ps.patterns.get(pat);
    if (set) { set.delete(client); if (set.size === 0) ps.patterns.delete(pat); }
    client.patterns.delete(pat);
    client.psubCount = client.patterns.size;
    out.push(psubFrame('punsubscribe', pat, client.subCount + client.psubCount));
  }
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

function messageFrame(chan, payload) {
  return Buffer.concat([
    Buffer.from('*3\r\n$7\r\nmessage\r\n', B_SUB),
    P.encBulk(Buffer.from(chan, B_SUB)),
    P.encBulk(payload),
  ]);
}

function pmessageFrame(pat, chan, payload) {
  return Buffer.concat([
    Buffer.from('*4\r\n$8\r\npmessage\r\n', B_SUB),
    P.encBulk(Buffer.from(pat, B_SUB)),
    P.encBulk(Buffer.from(chan, B_SUB)),
    P.encBulk(payload),
  ]);
}

function cmdPublish(server, argv, ctx) {
  const ps = server.pubsub;
  const chan = toStr(argv[1]);
  const payload = argv[2];
  let receivers = 0;
  const direct = ps.channels.get(chan);
  if (direct) {
    const frame = messageFrame(chan, payload);
    for (const c of direct) { c.socket.write(frame); receivers++; }
  }
  for (const [pat, clients] of ps.patterns) {
    if (globMatch(pat, chan)) {
      const frame = pmessageFrame(pat, chan, payload);
      for (const c of clients) { c.socket.write(frame); receivers++; }
    }
  }
  server.stats.pubsubMessages += receivers;
  return ctx.int(receivers);
}

function cmdPubSub(server, argv, ctx) {
  const ps = server.pubsub;
  const sub = toStr(argv[1]).toUpperCase();
  if (sub === 'CHANNELS') {
    const pat = argv.length > 2 ? toStr(argv[2]) : null;
    const out = [];
    for (const ch of ps.channels.keys()) {
      if (!pat || globMatch(pat, ch)) out.push(P.encBulk(Buffer.from(ch, B_SUB)));
    }
    return ctx.arr(out);
  }
  if (sub === 'NUMSUB') {
    const out = [];
    for (let i = 2; i < argv.length; i++) {
      const ch = toStr(argv[i]);
      const set = ps.channels.get(ch);
      out.push(P.encBulk(Buffer.from(ch, B_SUB)), P.encInt(set ? set.size : 0));
    }
    return ctx.arr(out);
  }
  if (sub === 'NUMPAT') return ctx.int(ps.patterns.size);
  if (sub === 'SHARDCHANNELS') return ctx.arr([]);
  if (sub === 'SHARDNUMSUB') return ctx.arr([]);
  throw err(`ERR Unknown PUBSUB subcommand or wrong number of arguments for '${toStr(argv[1])}'`);
}

module.exports = {
  cmdSubscribe, cmdUnsubscribe, cmdPSubscribe, cmdPUnsubscribe,
  cmdPublish, cmdPubSub, messageFrame, pmessageFrame,
};
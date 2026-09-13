const u = require('../src/util');
const P = require('../src/protocol');

console.log('glob', u.globMatch('user*', 'user123'), u.globMatch('[ab]*', 'b1'), u.globMatch('a?c', 'abc'), u.globMatch('a?c', 'adc'));

const CRLF = '\r\n';
const p = new P.RespParser();
p.feed(Buffer.from('*3' + CRLF + '$3' + CRLF + 'SET' + CRLF + '$1' + CRLF + 'k' + CRLF));
console.log('partial(empty expected):', JSON.stringify(p.parse()));
p.feed(Buffer.from('$5' + CRLF + 'hello' + CRLF));
console.log('complete:', JSON.stringify(p.parse()));

const q = new P.RespParser();
q.feed(Buffer.from('*1' + CRLF + '$4' + CRLF + 'PING' + CRLF + '*4' + CRLF + '$4' + CRLF + 'PING' + CRLF));
q.feed(Buffer.from('$11' + CRLF + 'hello world' + CRLF));
console.log('pipeline:', JSON.stringify(q.parse()));

const r = new P.RespParser();
r.feed(Buffer.from('PING' + CRLF + 'SET "a b" c' + CRLF + 'GET a b' + CRLF));
console.log('inline:', JSON.stringify(r.parse()));

console.log('encode:', P.encSimple('OK').toString(), P.encBulk('hi').toString(), P.encInt(-5).toString(), P.encNull().toString());
console.log('encodeArr:', P.encArr([P.encBulk('a'), P.encInt(1), P.encSimple('b')]).toString());

const bad = new P.RespParser();
try {
  bad.feed(Buffer.from('*1' + CRLF + '$x' + CRLF));
  bad.parse();
  console.log('ERROR: should have thrown');
} catch (e) {
  console.log('expected protocol err:', e.message);
}

// Bulk payload must be followed by a real CRLF terminator: declaring len=2
// but following with 'XY' (not \r\n) is a protocol error even though the
// declared number of bytes is present.
const badTail = new P.RespParser();
try {
  badTail.feed(Buffer.from('$2' + CRLF + 'abXY'));
  badTail.parse();
  console.log('ERROR: bad bulk tail should have thrown');
  process.exitCode = 1;
} catch (e) {
  console.log('expected bulk tail err:', e.message);
}

// The same framing with a proper CRLF still parses fine (and trailing bytes
// after the terminator remain in the buffer).
const goodTail = new P.RespParser();
goodTail.feed(Buffer.from('$2' + CRLF + 'ab' + CRLF));
const goodFrames = goodTail.parse();
console.log('good tail:', goodFrames.length === 1 && goodFrames[0].b.toString() === 'ab');
if (!(goodFrames.length === 1 && goodFrames[0].b.toString() === 'ab')) process.exitCode = 1;
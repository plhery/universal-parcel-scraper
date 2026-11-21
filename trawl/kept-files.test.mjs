import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keptFiles } from './kept-files.mjs';

const SENT = { 'user-agent': 'Synthetic/1.0', accept: '*/*' };
const reply = (url, headers, body = 'synthetic', { method = 'GET', status = 200, sent = SENT } = {}) => ({ url: () => url, status: () => status,
  request: () => ({ method: () => method, allHeaders: async () => sent }), headers: () => headers, body: async () => Buffer.from(body) });

test('a file with two lifetimes is kept for the shorter one', async () => {
  const files = keptFiles({ match: /^https:\/\/static\.example\.test\// });
  const url = 'https://static.example.test/app.js?v1';
  await files.keep(reply(url, { 'cache-control': 'max-age=604800, public, max-age=600', 'content-type': 'text/javascript', 'set-cookie': 'private' }), 1000);
  assert.deepEqual(files.get(url, 1000 + 599_999).headers, { 'content-type': 'text/javascript' });
  assert.equal(files.get(url, 1000 + 600_000), null);
});

test('a file that varies by request, or that its server does not let a cache reuse, stays on the network', async () => {
  const files = keptFiles({ match: /^https:\/\/static\.example\.test\// });
  const cases = [['a.js', { 'cache-control': 'max-age=600', vary: 'Cookie' }], ['b.js', { 'cache-control': 'max-age=600', vary: 'Accept-Encoding, User-Agent' }],
    ['c.js', { 'cache-control': 'max-age=600, no-cache' }], ['d.js', {}]];
  for (const [name, headers] of cases) await files.keep(reply(`https://static.example.test/${name}`, headers), 1000);
  await files.keep(reply('https://static.example.test/e.js', { 'cache-control': 'max-age=600', vary: 'Accept-Encoding, Origin' }), 1000);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(name => Boolean(files.get(`https://static.example.test/${name}.js`, 1001))), [false, false, false, false, true]);
});

test('without a stated lifetime a file is kept for a tenth of the time since it changed, and never once expired', async () => {
  const files = keptFiles({ match: /^https:\/\/static\.example\.test\// });
  const date = 'Sat, 07 Mar 2026 12:00:00 GMT', served = Date.parse(date);
  await files.keep(reply('https://static.example.test/recent.js', { date, 'last-modified': 'Sat, 07 Mar 2026 10:20:00 GMT' }), served);
  await files.keep(reply('https://static.example.test/old.js', { date, 'last-modified': 'Sat, 07 Feb 2026 12:00:00 GMT' }), served);
  await files.keep(reply('https://static.example.test/dated.js', { date, expires: 'Sat, 07 Mar 2026 12:05:00 GMT', 'last-modified': 'Sat, 07 Feb 2026 12:00:00 GMT' }), served);
  await files.keep(reply('https://static.example.test/expired.js', { date, expires: '0', 'last-modified': 'Sat, 07 Feb 2026 12:00:00 GMT' }), served);
  assert.ok(files.get('https://static.example.test/recent.js', served + 599_999));
  assert.equal(files.get('https://static.example.test/recent.js', served + 600_000), null);
  assert.ok(files.get('https://static.example.test/old.js', served + 24 * 3600_000 - 1));
  assert.equal(files.get('https://static.example.test/old.js', served + 24 * 3600_000), null);
  assert.ok(files.get('https://static.example.test/dated.js', served + 299_999));
  assert.equal(files.get('https://static.example.test/dated.js', served + 300_000), null);
  assert.equal(files.get('https://static.example.test/expired.js', served + 1), null);
});

test('a file that varies by a header its request did not send is served only to requests without it', async () => {
  const files = keptFiles({ match: /^https:\/\/static\.example\.test\// });
  let handler;
  const page = { route: async (match, handle) => { handler = handle; }, on: () => {} };
  await files.install(page);
  const now = Date.now();
  await files.keep(reply('https://static.example.test/a.js', { 'cache-control': 'max-age=600', vary: 'X-Fit' }), now);
  await files.keep(reply('https://static.example.test/b.js', { 'cache-control': 'max-age=600', vary: 'X-Fit' }, 'synthetic', { sent: { ...SENT, 'x-fit': '1' } }), now);
  await files.keep(reply('https://static.example.test/c.js', { 'cache-control': 'max-age=600', vary: 'Cookie' }), now);
  assert.deepEqual(['a', 'b', 'c'].map(name => Boolean(files.get(`https://static.example.test/${name}.js`, now + 1))), [true, false, false]);
  const ask = async sent => {
    let answer;
    await handler({ request: () => ({ method: () => 'GET', url: () => 'https://static.example.test/a.js', allHeaders: async () => sent }),
      fulfill: async reply => { answer = reply.body.toString(); }, fallback: async () => { answer = 'network'; } });
    return answer;
  };
  assert.equal(await ask(SENT), 'synthetic');
  assert.equal(await ask({ ...SENT, 'x-fit': '1' }), 'network');
});

test('each helper\'s files are its own', async () => {
  const one = keptFiles({ match: /^https:\/\/one\.example\.test\// }), two = keptFiles({ match: /^https:\/\/two\.example\.test\// });
  await one.keep(reply('https://one.example.test/a.js', { 'cache-control': 'max-age=600' }), 1000);
  await two.keep(reply('https://one.example.test/a.js', { 'cache-control': 'max-age=600' }), 1000);
  assert.ok(one.get('https://one.example.test/a.js', 1001));
  assert.equal(two.get('https://one.example.test/a.js', 1001), null);
});

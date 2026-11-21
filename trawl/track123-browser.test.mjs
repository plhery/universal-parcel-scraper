import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { keepTrack123File, postTrack123, track123Data, track123Kept, track123Key, track123Number, track123Request, runTrack123Browser } from './track123-browser.mjs';

const number = '909876543210';
const pageUrl = 'https://www.track123.com/carriers/fedex';
const query = 'https://www.track123.com/tk/api/v2/anonymous/track/query-track-nos';
const poll = 'https://www.track123.com/tk/api/v2/anonymous/track/polling-waybill';
const url = `${pageUrl}#trawl-number=${number}`;
const capture = { captureResponses: [query, poll] };
const ticket = { ret: 0, ticket: 't03SyntheticTicket*', randstr: '@syn' };
const shipment = (fields = {}) => ({ status: 200, text: JSON.stringify({ code: '00000', data: { landWaybillLists: [{
  trackingNo: number, localProviderCode: 'fedex', localProviderId: '165', querying: false, localDetails: [], ...fields }] } }) });

test('only a well-formed courier page and the exact capture sequence qualify', () => {
  assert.equal(track123Number(url, capture), number);
  assert.deepEqual(track123Request(`https://www.track123.com/carriers/dhl-germany#trawl-number=JJD0000000000000001`, capture),
    { code: 'dhl-germany', number: 'JJD0000000000000001' });
  for (const other of [url.replace('fedex', 'FedEx'), url.replace('fedex', 'fed%2Fex'), url.replace('fedex', 'fedex/x'),
    url.replace('fedex', `a${'b'.repeat(64)}`), url.replace('/carriers/fedex', '/carriers/'), url.replace('/carriers', '/track'),
    url.replace('www.track123.com', 'other.test'), url.replace('https:', 'http:'), `${url}&other=x`, `${pageUrl}?number=${number}`,
    `${pageUrl}?x=1#trawl-number=${number}`, `${pageUrl}#trawl-number=abc`, `${pageUrl}#trawl-number=ABCDEF`, `${pageUrl}#trawl-number=12`]) {
    assert.equal(track123Number(other, capture), null);
  }
  assert.equal(track123Number(url, { captureResponses: [query] }), null);
});

test('only history fields leave the service', () => {
  const payload = track123Data({ code: '00000', ticket: 'private', msg: 'private', data: { landWaybillLists: [{
    trackingNo: number, localProviderCode: 'fedex', localProviderId: 'private', recipient: 'private', querying: false,
    localDetails: [{ trackingNo: number, eventTime: '2026-01-08 10:00:00', recipient: 'private' }],
  }] } });
  assert.ok(!JSON.stringify(payload).includes('private'));
});

test('the request key hashes the time and the body with the pages\' altered MD5', () => {
  const body = JSON.stringify({ logisticsCode: 'fedex', trackNos: [number] });
  assert.equal(track123Key(body, '1700000000000'), 'aJwUlreuOaq3Mpo5m9zo2g155c4e44f2aa3381a47fd69cb44d9452689c1496b7ae39aab7329a399bdce8da');
  const key = track123Key(body);
  assert.match(key, /^[A-Za-z0-9+/]{22}[0-9a-f]{64}$/);
  assert.equal(key.slice(22, 54), track123Key(body, '1').slice(22, 54));
  assert.notEqual(key.slice(22, 54), track123Key(`${body} `, '1').slice(22, 54));
  assert.equal(Buffer.from(key.slice(0, 22), 'base64').toString('hex'), key.slice(54));
  // The standard hash is refused by Track123.
  assert.notEqual(key.slice(22, 54), createHash('md5').update(body).digest('hex'));
  // A body of several blocks and of more than one byte per character.
  assert.match(track123Key('é'.repeat(100), '1'), /^[A-Za-z0-9+/]{22}[0-9a-f]{64}$/);
});

/** A page whose blank document answers Tencent's check with `verdicts` and Track123's API with `replies`. */
function browser({ verdicts = [ticket], replies = [], address = pageUrl } = {}) {
  const seen = { routes: [], listeners: [], served: [], scripts: [], posts: [], waits: [], closed: 0, contexts: 0, policies: 0 };
  let verdict = null;
  const frame = {};
  const page = {
    mainFrame: () => frame,
    url: () => address,
    route: async (pattern, handler) => { seen.routes.push([pattern, handler]); },
    on: (event, handler) => { seen.listeners.push([event, handler]); },
    goto: async (value, options) => {
      assert.equal(value, pageUrl);
      assert.equal(options.waitUntil, 'domcontentloaded');
      const deliver = (navigation, from) => seen.routes[0][1]({ request: () => ({ isNavigationRequest: () => navigation, frame: () => from }),
        fulfill: async reply => { seen.served.push(reply); }, fallback: async () => { seen.served.push('network'); } });
      await deliver(true, frame); await deliver(false, frame); await deliver(true, {});
    },
    addScriptTag: async tag => {
      seen.scripts.push(tag);
      if (tag.content && verdicts.length) verdict = JSON.stringify(verdicts.shift());
    },
    waitForSelector: async (selector, options) => {
      seen.waits.push([selector, options.state, options.timeout]);
      if (verdict === null) await new Promise((_, reject) => setTimeout(reject, options.timeout, new Error('Timeout')));
    },
    locator: selector => ({ getAttribute: async () => { assert.equal(selector, 'html'); return verdict; }, evaluate: async () => { verdict = null; } }),
    evaluate: async (run, request) => {
      assert.equal(run, postTrack123);
      seen.posts.push(request);
      const next = replies.shift();
      return typeof next === 'function' ? next(request) : next;
    },
  };
  const handle = { browser: { newContext: async () => ({ newPage: async () => page, close: async () => { seen.closed += 1; } }) },
    noteTemporaryContext: () => { seen.contexts += 1; } };
  const run = (maxTimeout = 2000, extra = {}) => runTrack123Browser({ url, capture, maxTimeout, tier: 3, handle,
    installPolicy: async () => { seen.policies += 1; }, ...extra });
  return { seen, run };
}

test('serves only the courier page\'s own document, runs Tencent\'s check and sends the query as the page does', async () => {
  const { seen, run } = browser({ replies: [shipment()] });
  const result = await run();
  assert.equal(seen.routes[0][0], pageUrl);
  // The main frame's navigation is answered locally; its other requests and other frames reach the network.
  assert.deepEqual(seen.served.map(reply => reply === 'network' ? reply : [reply.status, reply.contentType]), [[200, 'text/html'], 'network', 'network']);
  assert.ok(!seen.served[0].body.includes(number));
  assert.deepEqual(seen.scripts[0], { url: 'https://turing.captcha.qcloud.com/TJCaptcha.js' });
  assert.match(seen.scripts[1].content, /new TencentCaptcha\("191371042",/);
  assert.equal(seen.scripts.length, 2);
  assert.deepEqual(seen.waits.map(wait => wait.slice(0, 2)), [['html[data-upc-track123-verdict]', 'attached']]);
  assert.equal(seen.posts.length, 1);
  const [sent] = seen.posts;
  assert.equal(sent.url, query);
  assert.equal(sent.body, JSON.stringify({ logisticsCode: 'fedex', trackNos: [number] }));
  assert.equal(sent.headers['track-key'].slice(22, 54), track123Key(sent.body, '1').slice(22, 54));
  assert.equal(sent.headers.ticket, ticket.ticket);
  assert.equal(sent.headers.randstr, ticket.randstr);
  assert.equal(sent.headers['content-type'], 'application/json;charset=UTF-8');
  assert.equal(sent.maxBytes, 2_000_000);
  assert.ok(sent.timeoutMs > 0 && sent.timeoutMs <= 2000);
  assert.equal(result.status, 'success');
  assert.equal(result.effectiveUrl, pageUrl);
  assert.ok(result.html.length > 0); // A capture-only result must survive the orchestrator's payload gate.
  assert.ok(!result.html.includes(number));
  assert.equal(result.capturedResponses.length, 1);
  assert.deepEqual({ ...result.capturedResponses[0], body: JSON.parse(result.capturedResponses[0].body) }, { url: query, status: 200, headers: {},
    truncated: false, base64Encoded: false, trackingNumberSubmitted: number,
    body: { code: '00000', data: { landWaybillLists: [{ trackingNo: number, localProviderCode: 'fedex', querying: false, localDetails: [] }] } } });
  assert.deepEqual([seen.contexts, seen.policies, seen.closed], [1, 1, 1]);
});

test('polls with the shipment\'s courier id and no ticket until Track123 has finished', async () => {
  const { seen, run } = browser({ replies: [shipment({ querying: true }), shipment({ querying: true, localProviderId: '166' }),
    shipment({ localDetails: [{ trackingNo: number, eventTime: '2026-01-08 10:00:00' }] })] });
  const started = Date.now();
  const result = await run();
  assert.ok(Date.now() - started >= 550);
  assert.deepEqual(seen.posts.map(post => [post.url, post.body]), [[query, JSON.stringify({ logisticsCode: 'fedex', trackNos: [number] })],
    [poll, JSON.stringify([{ logisticsId: '165', trackingNo: number }])], [poll, JSON.stringify([{ logisticsId: '166', trackingNo: number }])]]);
  for (const post of seen.posts.slice(1)) {
    assert.equal(post.headers.ticket, undefined);
    assert.equal(post.headers.randstr, undefined);
    assert.equal(post.headers['track-key'].slice(22, 54), track123Key(post.body, '1').slice(22, 54));
  }
  assert.deepEqual(result.capturedResponses.map(row => [row.url, JSON.parse(row.body).data.landWaybillLists[0].querying]),
    [[query, true], [poll, true], [poll, false]]);
  assert.equal(JSON.parse(result.capturedResponses.at(-1).body).data.landWaybillLists[0].localDetails.length, 1);
});

test('a reply that is refused, unreadable, oversized or about another shipment is the last word', async () => {
  for (const [reply, expected] of [
    [{ status: 200, text: JSON.stringify({ code: 'B0001', msg: 'System busy' }) }, { status: 200, body: { code: 'B0001', data: { landWaybillLists: null } } }],
    [{ status: 429 }, { status: 429, body: null }],
    [{ status: 0 }, { status: 0, body: null, error: 'track123-request-failed' }],
    [undefined, { status: 0, body: null, error: 'track123-request-failed' }],
    [{ status: 200, text: '<html>' }, { status: 200, body: null, error: 'track123-unreadable' }],
    [{ status: 200, truncated: true }, { status: 200, body: null, truncated: true }],
    [shipment({ querying: true, trackingNo: '909876543211' }), { status: 200 }],
    [shipment({ querying: true, localProviderId: undefined }), { status: 200 }],
    [shipment({ querying: true, localProviderId: '1 OR 1' }), { status: 200 }],
    [{ status: 200, text: JSON.stringify({ code: '00000', data: { landWaybillLists: [{ trackingNo: number, querying: true, localProviderId: '1' },
      { trackingNo: number, querying: true, localProviderId: '2' }] } }) }, { status: 200 }],
  ]) {
    const { seen, run } = browser({ replies: [reply, shipment()] });
    const result = await run();
    assert.equal(seen.posts.length, 1);
    assert.equal(result.capturedResponses.length, 1);
    const [row] = result.capturedResponses;
    assert.equal(row.status, expected.status);
    assert.equal(row.error, expected.error);
    assert.equal(row.truncated, expected.truncated === true);
    if ('body' in expected) assert.deepEqual(row.body && JSON.parse(row.body), expected.body);
  }
});

test('an unfinished later poll cannot expose an earlier success at the deadline', async () => {
  const { seen, run } = browser({ replies: [shipment({ querying: true }), () => new Promise(() => {})] });
  const result = await run(500);
  assert.equal(seen.posts.length, 2);
  assert.equal(result.capturedResponses.length, 2);
  assert.equal(result.capturedResponses.at(-1).error, 'track123-request-pending');
  assert.equal(result.capturedResponses.at(-1).status, 0);
  assert.equal(seen.closed, 1);
});

test('a reply that arrives after the deadline is not recorded', async () => {
  let answer;
  const { run } = browser({ replies: [() => new Promise(resolve => { answer = resolve; })] });
  const result = await run(80);
  answer(shipment());
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(result.capturedResponses.map(row => row.error), ['track123-request-pending']);
});

test('no query is sent without a ticket Tencent gave for this page', async () => {
  for (const verdicts of [[{ ret: 2 }], [{}], [{ ret: 0, ticket: '', randstr: '@syn' }], [{ ret: 0, ticket: 'has space', randstr: '@syn' }],
    [{ ret: 0, ticket: 't03Synthetic', randstr: 'line\nbreak' }], [{ ret: 0, ticket: 't03Synthetic' }], ['not an object']]) {
    const { seen, run } = browser({ verdicts, replies: [shipment()] });
    const result = await run();
    assert.equal(seen.posts.length, 0);
    assert.deepEqual(result.capturedResponses, []);
    assert.equal(result.status, 'success');
    assert.equal(seen.closed, 1);
  }
  // A check that waits for a visitor gives no verdict: the lookup ends at its deadline.
  const waiting = browser({ verdicts: [], replies: [shipment()] });
  assert.deepEqual((await waiting.run(120)).capturedResponses, []);
  assert.equal(waiting.seen.posts.length, 0);
  // Another address than the courier page's is not Track123's origin for the check.
  const moved = browser({ address: 'https://www.track123.com/', replies: [shipment()] });
  assert.deepEqual((await moved.run()).capturedResponses, []);
  assert.equal(moved.seen.scripts.length, 0);
});

test('Tencent\'s fallback ticket is asked again as the pages do, and never sent', { timeout: 10_000 }, async () => {
  const fallback = { ret: 0, ticket: 'trerror_1001_191371042_1700000000', randstr: '@syn' };
  const recovered = browser({ verdicts: [fallback, ticket], replies: [shipment()] });
  const started = Date.now();
  const result = await recovered.run(8000);
  assert.ok(Date.now() - started >= 2900);
  assert.equal(recovered.seen.scripts.filter(tag => tag.url).length, 1);
  assert.equal(recovered.seen.scripts.filter(tag => tag.content).length, 2);
  assert.equal(recovered.seen.posts.length, 1);
  assert.equal(recovered.seen.posts[0].headers.ticket, ticket.ticket);
  assert.equal(result.capturedResponses.length, 1);
  const refused = browser({ verdicts: [fallback, fallback, fallback, ticket], replies: [shipment()] });
  assert.deepEqual((await refused.run(400)).capturedResponses, []);
  assert.equal(refused.seen.posts.length, 0);
});

test('a lookup without budget or already cancelled opens nothing', async () => {
  for (const extra of [{ maxTimeout: 0 }, { maxTimeout: Number.NaN }, { signal: AbortSignal.abort() }]) {
    const { seen, run } = browser({ replies: [shipment()] });
    const result = await run(extra.maxTimeout ?? 2000, extra);
    assert.deepEqual(result.capturedResponses, []);
    assert.deepEqual([seen.contexts, seen.posts.length], [0, 0]);
  }
  const cancelled = new AbortController();
  const { seen, run } = browser({ replies: [() => new Promise(() => {})] });
  const waiting = run(5000, { signal: cancelled.signal });
  await new Promise(resolve => setTimeout(resolve, 30));
  cancelled.abort();
  assert.equal((await waiting).capturedResponses.at(-1).error, 'track123-request-pending');
  assert.equal(seen.closed, 1);
});

test('the page\'s reader posts once and bounds what it reads', async t => {
  const stream = (...chunks) => ({ getReader: () => { let index = 0, cancelled = false;
    return { read: async () => index < chunks.length && !cancelled ? { done: false, value: Buffer.from(chunks[index++]) } : { done: true },
      cancel: async () => { cancelled = true; }, releaseLock: () => {} }; }, cancel: async () => {} });
  const calls = [];
  const answer = reply => { t.mock.method(globalThis, 'fetch', async (address, options) => { calls.push([address, options]); return reply(options); }); };
  const request = { url: query, body: '{"a":1}', headers: { 'track-key': 'k' }, timeoutMs: 1000, maxBytes: 10 };
  answer(() => ({ status: 200, body: stream('{"code":', '"1"}') }));
  assert.deepEqual(await postTrack123({ ...request, maxBytes: 100 }), { status: 200, text: '{"code":"1"}' });
  assert.deepEqual([calls[0][0], calls[0][1].method, calls[0][1].body, calls[0][1].headers, calls[0][1].credentials, calls[0][1].redirect],
    [query, 'POST', '{"a":1}', { 'track-key': 'k' }, 'same-origin', 'error']);
  assert.deepEqual(await postTrack123(request), { status: 200, truncated: true });
  answer(() => ({ status: 403, body: stream('<html>') }));
  assert.deepEqual(await postTrack123(request), { status: 403 });
  answer(() => ({ status: 200, body: null }));
  assert.deepEqual(await postTrack123(request), { status: 200 });
  answer(() => { throw new TypeError('NetworkError'); });
  assert.deepEqual(await postTrack123(request), { status: 0 });
  answer(options => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  assert.deepEqual(await postTrack123({ ...request, timeoutMs: 20 }), { status: 0 });
});

/** A reply the browser read from the network, as the helper's response listener sees it. */
function reply(address, { control = 'max-age=600', status = 200, method = 'GET', body = Buffer.from('synthetic'), type = 'text/javascript' } = {}) {
  return { url: () => address, status: () => status, request: () => ({ method: () => method }),
    headers: () => ({ 'content-type': type, 'cache-control': control, 'set-cookie': 'synthetic=1' }),
    body: async () => { if (body === null) throw new Error('gone'); return body; } };
}

test('keeps Tencent\'s script and style files for as long as their replies allow, a day at most', async () => {
  const script = 'https://turing.captcha.qcloud.com/synthetic-a.js', style = 'https://turing.captcha.gtimg.com/1/synthetic-a.0f0f.css';
  await keepTrack123File(reply(script), 1000);
  await keepTrack123File(reply(style, { control: 'public, max-age=2592000', type: 'text/css' }), 1000);
  assert.deepEqual(track123Kept(script, 1000 + 599_999).headers, { 'content-type': 'text/javascript' });
  assert.equal(track123Kept(script, 1000 + 599_999).body.toString(), 'synthetic');
  // A later reply does not extend a kept file's time.
  await keepTrack123File(reply(script, { control: 'max-age=9000' }), 500_000);
  assert.equal(track123Kept(script, 1000 + 600_000), null);
  assert.ok(track123Kept(style, 1000 + 86_399_999));
  assert.equal(track123Kept(style, 1000 + 86_400_000), null);
});

test('keeps nothing else', async () => {
  const cases = [
    reply('https://turing.captcha.qcloud.com/tdc.js?app_data=1'),
    reply('https://turing.captcha.qcloud.com/cap_union_prehandle'),
    reply('https://turing.captcha.qcloud.com.example/synthetic-b.js'),
    reply('http://turing.captcha.qcloud.com/synthetic-b.js'),
    reply('https://www.track123.com/synthetic-b.js'),
    reply('https://turing.captcha.qcloud.com/synthetic-c.js', { control: '' }),
    reply('https://turing.captcha.qcloud.com/synthetic-d.js', { control: 'no-cache, max-age=600' }),
    reply('https://turing.captcha.qcloud.com/synthetic-e.js', { control: 'private, max-age=600' }),
    reply('https://turing.captcha.qcloud.com/synthetic-f.js', { status: 404 }),
    reply('https://turing.captcha.qcloud.com/synthetic-g.js', { method: 'POST' }),
    reply('https://turing.captcha.qcloud.com/synthetic-h.js', { body: null }),
    reply('https://turing.captcha.qcloud.com/synthetic-i.js', { body: Buffer.alloc(0) }),
    reply('https://turing.captcha.qcloud.com/synthetic-j.js', { body: Buffer.alloc(2_000_001) }),
  ];
  for (const item of cases) {
    await keepTrack123File(item, 1000);
    assert.equal(track123Kept(item.url(), 1001), null, item.url());
  }
});

test('holds a bounded number of files', async () => {
  const address = index => `https://turing.captcha.gtimg.com/1/synthetic-many-${index}.js`;
  for (let index = 0; index < 20; index += 1) await keepTrack123File(reply(address(index)), 1000);
  assert.equal(Array.from({ length: 20 }, (_, index) => track123Kept(address(index), 1001)).filter(Boolean).length, 16);
  assert.equal(track123Kept(address(0), 1001), null);
  assert.ok(track123Kept(address(19), 1001));
});

test('a lookup answers a kept file itself and lets every other request reach the network', async () => {
  const { seen, run } = browser({ replies: [shipment()] });
  await run();
  const [pattern, handler] = seen.routes[1];
  assert.ok(pattern.test('https://turing.captcha.qcloud.com/TJCaptcha.js'));
  assert.ok(pattern.test('https://turing.captcha.gtimg.com/1/tgJCap.0f0f0f0f.js'));
  assert.ok(!pattern.test('https://turing.captcha.qcloud.com/tdc.js?app_data=1'));
  assert.ok(!pattern.test('https://www.track123.com/carriers/fedex'));
  const address = 'https://turing.captcha.gtimg.com/1/synthetic-route.js';
  const ask = async (method = 'GET') => {
    const out = [];
    await handler({ request: () => ({ method: () => method, url: () => address }), fulfill: async value => { out.push(value); }, fallback: async () => { out.push('network'); } });
    return out[0];
  };
  assert.equal(await ask(), 'network');
  assert.deepEqual(seen.listeners.map(([event]) => event), ['response']);
  seen.listeners[0][1](reply(address));
  await new Promise(resolve => setImmediate(resolve));
  const served = await ask();
  assert.deepEqual([served.status, served.headers, served.body.toString()], [200, { 'content-type': 'text/javascript' }, 'synthetic']);
  assert.equal(await ask('POST'), 'network');
});

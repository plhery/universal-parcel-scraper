import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { DIGICERT_GLOBAL_G2_CA1, kuwaitPostBrowserNumber, kuwaitPostPageUrl, kuwaitPostReplyValue, kuwaitPostRequestMatches, projectKuwaitPostReply,
  relayKuwaitPostRequest, runKuwaitPostBrowser, KUWAIT_POST_PAGE as PAGE } from './kuwait-post-browser.mjs';

// Synthetic replies in the tracker's shape, with invented values.
const number = 'ZZ987654326KW', url = kuwaitPostPageUrl(number), capture = { captureResponses: [PAGE] };
const scan = (extra = {}) => ({ MAILITM_LOCAL_ID: 'PRIVATE', COUNTRY: 'KW', COUNTRY_NM: 'Kuwait', EVENT_TYPE_CD: 1,
  DEFAULT_EVENT_TYPE_NM: 'Receive item from customer (Otb)', EVENT_TYPE_NM: 'Receive item from customer (Otb)', MAIL_CATEGORY_NM: 'Air',
  NEXT_OFFICE: 'SAMPLE OFFICE', EVENT_LOCAL_DT: '2026-08-01 09:15:00.000', LOCATION: 'SAMPLE OFFICE', NON_DELIVERY_REASON_NM: null,
  NON_DELIVERY_MEASURE_NM: null, RETENTION_REASON_NM: null, SIGNATORY_NM: 'PRIVATE', SIGNATURE_FILE_PATH: 'PRIVATE', CONDITION_NM: 'Item Received in good condition', ...extra });
const reply = value => `0:{"a":"$@1","f":"","b":"build"}\n1:${JSON.stringify(value)}\n`;
const found = reply({ success: true, message: '', data: [scan()], groupedByCountry: [{ country: 'PRIVATE' }] });
const body = (n = number, token = 'PRIVATE') => JSON.stringify([{ trackingId: n, captchaToken: token }]);
const request = (page, extra = {}) => ({ url: () => PAGE, method: () => 'POST', frame: () => page.mainFrame(), resourceType: () => 'fetch',
  headers: () => ({ 'next-action': '7f00000000000000000000000000000000000000aa', accept: 'text/x-component' }), postData: () => body(), ...extra });

function fixture({ status = 200, data = found, token = true, delay = 0, cooldown = 0, abort = null, fails = false, during = null } = {}) {
  const state = { closed: 0, native: 0, checkbox: 0, filled: null, relayed: [], aborted: 0, fulfilled: 0, fellBack: 0, routeBeforeNavigation: false, opened: null };
  const frame = {};
  let routeHandler;
  const routed = async sent => routeHandler({ request: () => sent, abort: async () => { state.aborted++; }, fallback: async () => { state.fellBack++; },
    fulfill: async () => { state.fulfilled++; } });
  const page = { route: async (_, fn) => { routeHandler = fn; }, mainFrame: () => frame,
    goto: async address => {
      state.opened = address; state.routeBeforeNavigation = !!routeHandler;
      await routed(request(page, { url: () => PAGE, method: () => 'GET', resourceType: () => 'document' }));
      return { status: () => 200 };
    },
    waitForFunction: async () => {}, frameLocator: () => ({ first: () => ({ locator: () => ({ click: async () => { state.checkbox++; } }) }) }),
    locator: selector => ({ first: () => ({ waitFor: async () => {}, inputValue: async () => token ? 'PRIVATE' : '' }), fill: async value => { state.filled = value; await during?.(routed, page); }, click: async () => {
      assert.equal(selector, 'form button[type="submit"]');
      await routed(request(page, { postData: () => body(state.filled) }));
    } }) };
  const relay = async (sent, { jar }) => {
    state.relayed.push(sent.method()); assert(jar instanceof Map);
    if (sent.method() === 'GET') return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html></html>') };
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (fails) throw new Error('relay');
    return { status, headers: { 'content-type': 'text/x-component', 'retry-after': '60' }, body: Buffer.from(data) };
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { state, page, routed, options: { url, capture, handle: { browser: { newContext: async () => context } }, tier: 3, maxTimeout: 1000,
    signal: abort, relay, audioBackoff: { remainingMs: async () => cooldown, block: () => {} }, solveNativeCaptcha: async () => { state.native++; } } };
}

test('takes only the tracker with the whole item code after its hash and the reply capture', () => {
  assert.equal(kuwaitPostBrowserNumber(url, capture), number);
  for (const u of [url + 'X', url.replace('#', '?trackingId='), url.replace('/en/', '/ar/'), url.replace('https://', 'https://user@'), kuwaitPostPageUrl('ZZ98765432KW'), kuwaitPostPageUrl(number.toLowerCase())])
    assert.equal(kuwaitPostBrowserNumber(u, capture), null);
  assert.equal(kuwaitPostBrowserNumber(url, { captureResponses: [PAGE, PAGE] }), null);
});

test('binds the form\'s main-frame server action with the whole code and one token', () => {
  const f = fixture(); assert(kuwaitPostRequestMatches(request(f.page), f.page, number));
  assert(kuwaitPostRequestMatches(request(f.page, { url: () => url }), f.page, number));
  for (const r of [request(f.page, { method: () => 'GET' }), request(f.page, { frame: () => ({}) }), request(f.page, { url: () => PAGE + '?x=1' }),
    request(f.page, { headers: () => ({}) }), request(f.page, { postData: () => body(number.slice(0, -1) + 'X') }), request(f.page, { postData: () => body(number, '') }),
    request(f.page, { postData: () => JSON.stringify([{ trackingId: number, captchaToken: 'T', other: 1 }]) }),
    request(f.page, { postData: () => JSON.stringify([{ trackingId: number, captchaToken: 'T' }, { trackingId: number, captchaToken: 'T' }]) }),
    request(f.page, { postData: () => 'trackingId=' + number })]) assert(!kuwaitPostRequestMatches(r, f.page, number));
});

test('reads the action\'s value and keeps each scan\'s outcome fields only', () => {
  const projected = JSON.parse(projectKuwaitPostReply(kuwaitPostReplyValue(found)));
  assert.deepEqual(Object.keys(projected), ['success', 'message', 'data']);
  assert.deepEqual(projected.data[0], { COUNTRY: 'KW', COUNTRY_NM: 'Kuwait', EVENT_TYPE_CD: 1, EVENT_TYPE_NM: 'Receive item from customer (Otb)',
    DEFAULT_EVENT_TYPE_NM: 'Receive item from customer (Otb)', EVENT_LOCAL_DT: '2026-08-01 09:15:00.000', LOCATION: 'SAMPLE OFFICE',
    NON_DELIVERY_REASON_NM: null, NON_DELIVERY_MEASURE_NM: null, RETENTION_REASON_NM: null });
  assert(!JSON.stringify(projected).includes('PRIVATE'));
  assert.deepEqual(JSON.parse(projectKuwaitPostReply(kuwaitPostReplyValue(reply({ success: false, message: 'rate_limit_exceeded', retryAfterSeconds: 60, data: [] })))),
    { success: false, message: 'rate_limit_exceeded', retryAfterSeconds: 60, data: [] });
  assert.equal(JSON.parse(projectKuwaitPostReply(kuwaitPostReplyValue(reply({ success: true, data: [scan({ LOCATION: '$$1 OFFICE', COUNTRY_NM: '$undefined' })] })))).data[0].LOCATION, '$1 OFFICE');
  for (const text of ['1:{"success":true}\n', '0:{"a":"$@2"}\n1:{"success":true}\n', '0:{"a":"$@1"}\n1:E{"digest":"1"}\n', '<html>error</html>', '0:{"a":"$@1"}\n1:{}\n1:{}\n'])
    assert.equal(projectKuwaitPostReply(kuwaitPostReplyValue(text)), null);
});

test('relays the page and captures the bound reply, without the token, cookies or signatory', async () => {
  const f = fixture({ delay: 10 }); const r = await runKuwaitPostBrowser(f.options);
  assert(f.state.routeBeforeNavigation); assert.equal(f.state.opened, url); assert.equal(f.state.filled, number); assert.equal(f.state.closed, 1);
  assert.deepEqual(f.state.relayed, ['GET', 'POST']);
  assert.equal(r.statusCode, 200); assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].url, PAGE);
  assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(r.capturedResponses[0].body, projectKuwaitPostReply(kuwaitPostReplyValue(found))); assert.equal(r.html, ''); assert.deepEqual(r.cookies, []);
  assert(!JSON.stringify(r).includes('PRIVATE'));
});

test('sends only the bound POST, once, and leaves other hosts and pictures alone', async () => {
  const f = fixture({ during: async (routed, page) => {
    for (const extra of [{ postData: () => body(number, '') }, { method: () => 'GET', resourceType: () => 'image' }, { method: () => 'PUT' }]) await routed(request(page, extra));
    await routed(request(page, { url: () => 'https://moc.gov.kw.example/x', method: () => 'GET' }));
  } });
  const r = await runKuwaitPostBrowser(f.options);
  assert.deepEqual(f.state.relayed, ['GET', 'POST']); assert.equal(f.state.aborted, 3); assert.equal(f.state.fellBack, 1); assert.equal(r.capturedResponses.length, 1);
  const g = fixture({ during: async (routed, page) => { await routed(request(page)); } });
  const twice = await runKuwaitPostBrowser(g.options);
  assert.deepEqual(g.state.relayed, ['GET', 'POST']); assert.equal(g.state.aborted, 1); assert.equal(twice.capturedResponses.length, 1);
});

test('keeps status refusals, block pages, unreadable replies and a failed relay apart from replies', async () => {
  for (const status of [403, 429, 503]) {
    const f = fixture({ status }); const r = await runKuwaitPostBrowser(f.options);
    assert.equal(r.capturedResponses.at(-1).status, status); assert.equal(r.capturedResponses.at(-1).body, null); assert.equal(f.state.closed, 1);
  }
  assert.deepEqual((await runKuwaitPostBrowser(fixture({ status: 429 }).options)).capturedResponses[0].headers, { 'content-type': 'text/x-component', 'retry-after': '60' });
  assert.equal((await runKuwaitPostBrowser(fixture({ data: '<html><title>Access Denied</title></html>' }).options)).capturedResponses[0].error, 'challenge-html');
  assert.equal((await runKuwaitPostBrowser(fixture({ data: '0:{"a":"$@1"}\n1:E{"digest":"1"}\n' }).options)).capturedResponses[0].error, 'invalid-reply');
  assert.equal((await runKuwaitPostBrowser(fixture({ status: 307 }).options)).capturedResponses[0].error, 'unexpected-redirect');
  const failed = await runKuwaitPostBrowser(fixture({ fails: true }).options);
  assert.deepEqual([failed.capturedResponses[0].status, failed.capturedResponses[0].error], [0, 'relay-failed']);
});

test('does not send the form without a token, and never overrides the audio pause', async () => {
  const f = fixture({ token: false, cooldown: 1000 }); const r = await runKuwaitPostBrowser(f.options);
  assert.equal(f.state.native, 0); assert.equal(f.state.checkbox, 1); assert.deepEqual(f.state.relayed, ['GET']); assert.equal(r.capturedResponses.length, 0); assert.equal(f.state.closed, 1);
  const g = fixture(); await runKuwaitPostBrowser(g.options); assert.equal(g.state.native, 1); assert.equal(g.state.checkbox, 0);
});

test('deadline and cancellation close the context and keep no late reply', async () => {
  const f = fixture({ delay: 100 }); f.options.maxTimeout = 30; const r = await runKuwaitPostBrowser(f.options);
  assert.equal(f.state.closed, 1); assert.equal(r.capturedResponses.length, 0);
  await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(r.capturedResponses.length, 0);
  const c = new AbortController(); c.abort(); const g = fixture({ abort: c.signal }); await runKuwaitPostBrowser(g.options); assert.deepEqual(g.state.relayed, []);
});

function fakeHttps({ status = 200, headers = {}, chunks = [Buffer.from('ok')] } = {}) {
  const calls = [];
  const requestImpl = (address, options, onReply) => {
    const sent = new EventEmitter(); calls.push({ address: String(address), options, body: null });
    sent.destroy = error => sent.emit('error', error);
    sent.end = data => {
      calls.at(-1).body = data ?? null;
      const replyStream = new EventEmitter(); replyStream.statusCode = status; replyStream.headers = headers;
      onReply(replyStream);
      for (const chunk of chunks) replyStream.emit('data', chunk);
      replyStream.emit('end');
    };
    return sent;
  };
  return { calls, requestImpl };
}
const pageRequest = (extra = {}) => ({ url: () => PAGE, method: () => 'GET', postDataBuffer: () => null,
  allHeaders: async () => ({ host: 'moc.gov.kw', 'accept-encoding': 'gzip, br', cookie: 'a=browser; b=browser', origin: 'https://moc.gov.kw', ':method': 'GET' }), ...extra });

test('relays with the left-out intermediate, its own cookies and an uncompressed body', async () => {
  const fake = fakeHttps({ headers: { 'content-type': 'text/html', 'content-length': '2', connection: 'keep-alive', 'set-cookie': ['a=site; Path=/', 'c=site; HttpOnly'] } });
  const jar = new Map([['b', 'b=jar']]);
  const out = await relayKuwaitPostRequest(pageRequest(), { timeoutMs: 1000, jar, requestImpl: fake.requestImpl });
  const { options } = fake.calls[0];
  assert.equal(fake.calls[0].address, PAGE); assert(options.ca.includes(DIGICERT_GLOBAL_G2_CA1)); assert(options.ca.length > 1); assert.equal(options.servername, 'moc.gov.kw');
  assert.deepEqual(options.headers, { origin: 'https://moc.gov.kw', cookie: 'a=browser; b=jar', 'accept-encoding': 'identity' });
  assert.deepEqual(out.headers, { 'content-type': 'text/html', 'set-cookie': 'a=site; Path=/\nc=site; HttpOnly' });
  assert.deepEqual([...jar.entries()], [['b', 'b=jar'], ['a', 'a=site'], ['c', 'c=site']]);
  assert.equal(out.body.toString(), 'ok');
  const post = fakeHttps({ headers: { 'content-encoding': 'gzip' }, chunks: [gzipSync('1:{}')] });
  const posted = await relayKuwaitPostRequest(pageRequest({ method: () => 'POST', postDataBuffer: () => Buffer.from(body()) }), { timeoutMs: 1000, requestImpl: post.requestImpl });
  assert.equal(post.calls[0].body.toString(), body()); assert.equal(posted.body.toString(), '1:{}'); assert.equal(posted.headers['content-encoding'], undefined);
  await assert.rejects(relayKuwaitPostRequest(pageRequest({ url: () => 'https://example.com/' }), { timeoutMs: 1000, requestImpl: fake.requestImpl }));
  await assert.rejects(relayKuwaitPostRequest(pageRequest({ method: () => 'PUT' }), { timeoutMs: 1000, requestImpl: fake.requestImpl }));
  await assert.rejects(relayKuwaitPostRequest(pageRequest(), { timeoutMs: 1000, requestImpl: fakeHttps({ chunks: [Buffer.alloc(3_000_000), Buffer.alloc(3_000_000)] }).requestImpl }));
});

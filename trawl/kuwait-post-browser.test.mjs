import test from 'node:test';
import assert from 'node:assert/strict';
import { kuwaitPostBrowserNumber, kuwaitPostPageUrl, kuwaitPostReplyValue, kuwaitPostRequestMatches, projectKuwaitPostReply,
  runKuwaitPostBrowser, KUWAIT_POST_PAGE as PAGE } from './kuwait-post-browser.mjs';

// Synthetic replies in the tracker's shape, with invented values.
const number = 'RR000000005KW', url = kuwaitPostPageUrl(number), capture = { captureResponses: [PAGE] };
const scan = (extra = {}) => ({ MAILITM_LOCAL_ID: 'PRIVATE', COUNTRY: 'KW', COUNTRY_NM: 'Kuwait', EVENT_TYPE_CD: 1,
  DEFAULT_EVENT_TYPE_NM: 'Receive item from customer (Otb)', EVENT_TYPE_NM: 'Receive item from customer (Otb)', MAIL_CATEGORY_NM: 'Air',
  NEXT_OFFICE: 'SAMPLE OFFICE', EVENT_LOCAL_DT: '2026-08-01 09:15:00.000', LOCATION: 'SAMPLE OFFICE', NON_DELIVERY_REASON_NM: null,
  NON_DELIVERY_MEASURE_NM: null, RETENTION_REASON_NM: null, SIGNATORY_NM: 'PRIVATE', SIGNATURE_FILE_PATH: 'PRIVATE', CONDITION_NM: 'Item Received in good condition', ...extra });
const reply = value => `0:{"a":"$@1","f":"","b":"build"}\n1:${JSON.stringify(value)}\n`;
const found = reply({ success: true, message: '', data: [scan()], groupedByCountry: [{ country: 'PRIVATE' }] });
const body = (n = number, token = 'PRIVATE') => JSON.stringify([{ trackingId: n, captchaToken: token }]);
const request = (page, extra = {}) => ({ url: () => PAGE, method: () => 'POST', frame: () => page.mainFrame(),
  headers: () => ({ 'next-action': '7f00000000000000000000000000000000000000aa', accept: 'text/x-component' }), postData: () => body(), ...extra });

function fixture({ status = 200, data = found, token = true, delay = 0, cooldown = 0, abort = null } = {}) {
  const state = { closed: 0, native: 0, checkbox: 0, filled: null, sent: 0, aborted: 0, observerBeforeNavigation: false, opened: null }; const frame = {};
  let responseHandler, routeHandler;
  const page = { route: async (_, fn) => { routeHandler = fn; }, mainFrame: () => frame, on: (event, fn) => { if (event === 'response') responseHandler = fn; }, off: () => {},
    goto: async address => { state.opened = address; state.observerBeforeNavigation = !!responseHandler; return { status: () => 200 }; },
    waitForFunction: async () => {}, frameLocator: () => ({ first: () => ({ locator: () => ({ click: async () => { state.checkbox++; } }) }) }),
    locator: selector => ({ first: () => ({ waitFor: async () => {}, inputValue: async () => token ? 'PRIVATE' : '' }), fill: async value => { state.filled = value; }, click: async () => {
      assert.equal(selector, 'form button[type="submit"]'); const sent = request(page, { postData: () => body(state.filled) });
      await routeHandler({ request: () => sent, abort: async () => { state.aborted++; }, fallback: async () => { state.sent++; } });
      if (state.aborted) return;
      responseHandler({ request: () => sent, url: () => PAGE, status: () => status, headers: () => ({ 'content-type': 'text/x-component' }),
        body: async () => { if (delay) await new Promise(r => setTimeout(r, delay)); return Buffer.from(data); } });
    } }) };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { state, page, options: { url, capture, handle: { browser: { newContext: async () => context } }, tier: 3, maxTimeout: 1000,
    signal: abort, audioBackoff: { remainingMs: async () => cooldown, block: () => {} }, solveNativeCaptcha: async () => { state.native++; } } };
}

test('takes only the tracker with the whole item code after its hash and the reply capture', () => {
  assert.equal(kuwaitPostBrowserNumber(url, capture), number);
  for (const u of [url + 'X', url.replace('#', '?trackingId='), url.replace('/en/', '/ar/'), url.replace('https://', 'https://user@'), kuwaitPostPageUrl('RR00000005KW'), kuwaitPostPageUrl(number.toLowerCase())])
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

test('captures the bound reply after delayed decoding, without the token, cookies or signatory', async () => {
  const f = fixture({ delay: 10 }); const r = await runKuwaitPostBrowser(f.options);
  assert(f.state.observerBeforeNavigation); assert.equal(f.state.opened, url); assert.equal(f.state.filled, number); assert.equal(f.state.sent, 1); assert.equal(f.state.closed, 1);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].url, PAGE); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(r.capturedResponses[0].body, projectKuwaitPostReply(kuwaitPostReplyValue(found))); assert.equal(r.html, ''); assert.deepEqual(r.cookies, []);
  assert(!JSON.stringify(r).includes('PRIVATE'));
});

test('keeps status refusals, block pages and unreadable replies apart from replies', async () => {
  for (const status of [403, 429, 503]) { const f = fixture({ status }); const r = await runKuwaitPostBrowser(f.options); assert.equal(r.capturedResponses.at(-1).status, status); assert.equal(r.capturedResponses.at(-1).body, null); assert.equal(f.state.closed, 1); }
  const blocked = await runKuwaitPostBrowser(fixture({ data: '<html><title>Access Denied</title></html>' }).options);
  assert.equal(blocked.capturedResponses[0].error, 'challenge-html');
  const unreadable = await runKuwaitPostBrowser(fixture({ data: '0:{"a":"$@1"}\n1:E{"digest":"1"}\n' }).options);
  assert.equal(unreadable.capturedResponses[0].error, 'invalid-reply');
});

test('does not send the form without a token, and never overrides the audio pause', async () => {
  const f = fixture({ token: false, cooldown: 1000 }); const r = await runKuwaitPostBrowser(f.options);
  assert.equal(f.state.native, 0); assert.equal(f.state.checkbox, 1); assert.equal(f.state.sent, 0); assert.equal(r.capturedResponses.length, 0); assert.equal(f.state.closed, 1);
  const g = fixture(); await runKuwaitPostBrowser(g.options); assert.equal(g.state.native, 1); assert.equal(g.state.checkbox, 0);
});

test('deadline and cancellation close the context and discard unfinished bodies', async () => {
  const f = fixture({ delay: 100 }); f.options.maxTimeout = 30; const r = await runKuwaitPostBrowser(f.options); assert.equal(f.state.closed, 1); assert.equal(r.capturedResponses.at(-1)?.body ?? null, null);
  const c = new AbortController(); c.abort(); const g = fixture({ abort: c.signal }); await runKuwaitPostBrowser(g.options); assert.equal(g.state.sent, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEDDLER_ORIGIN, peddlerPageUrl, peddlerLoaderUrl, peddlerBrowserNumber, boundPeddlerAction, boundPeddlerLoader,
  projectPeddlerReply, runPeddlerBrowser } from './peddler-browser.mjs';

const number = 'NLEXP0012345678INTPED', url = peddlerPageUrl(number), loader = peddlerLoaderUrl(number);
const capture = { captureResponses: [loader] }, frame = {};
const payload = { data: { inquiryNumber: number, deliveryOptions: { token: 'PRIVATE' }, carrier: { name: 'Cainiao' }, package: { status: 'DELIVERED',
  trackingNumber: number, estimatedDeliveryDate: '2026-03-18T11:32:17.374Z', events: [
    { code: 603, status: 'FAILED_ATTEMPT', ts: '2026-03-16T15:10:04.239Z', failedStatus: 'INCOMPLETE_ADDRESS', lang: { en: 'Incomplete address', nl: 'PRIVATE' },
      details: { lang: { en: { headline: 'Delivery attempt failed', description: 'At destination' }, nl: { headline: 'PRIVATE' } }, courierName: 'PRIVATE', reason: 'PRIVATE' },
      gps: { lat: 52.1, lng: 5.1 } },
    { code: 502, status: 'DELIVERED', ts: '2026-03-18T11:32:17.374Z', details: { lang: { en: { headline: 'Delivered' } }, courierName: 'PRIVATE', deliveredInMailbox: 'PRIVATE' } },
  ] } }, ENV: { GOOGLE_MAP_API_KEY: 'PRIVATE' } };
const form = (n = number, token = 'PRIVATE') => new URLSearchParams({ __rvfInternalFormId: 'trackingForm', inquiryNumber: n, 'cf-turnstile-response': token }).toString();
const action = (extra = {}) => ({ method: () => 'POST', url: () => `${PEDDLER_ORIGIN}/?index=&inquiryNumber=${number}&_data=routes%2F_index`,
  postData: () => form(), frame: () => frame, ...extra });
const load = (extra = {}) => ({ method: () => 'GET', url: () => loader, frame: () => frame, ...extra });

function fixture({ body = JSON.stringify(payload), status = 200, actionStatus = 204, token = 'TOKEN', timeout = 1000, clickFails = false } = {}) {
  const handlers = {}, state = { closed: 0, submits: 0, policy: 0, aborted: 0, fallback: 0, clicks: 0 };
  let route, value = token;
  const respond = (request, s, headers, text = '') => handlers.response?.({ request: () => request, status: () => s, headers: () => headers,
    body: async () => Buffer.from(text) });
  const submit = async () => {
    state.submits++;
    const post = action({ postData: () => form(number, value) });
    await route({ request: () => post, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
    respond(post, actionStatus, actionStatus === 204 ? { 'x-remix-redirect': `/trackntrace/${number}`, 'set-cookie': 'PRIVATE' } : {}, '');
    if (actionStatus !== 204) { value = ''; return; }
    const get = load();
    await route({ request: () => get, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
    setTimeout(() => respond(get, status, { 'content-type': 'application/json', 'retry-after': '60' }, body), 1);
  };
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    route: async (re, f) => { assert.ok(re.test(loader)); assert.ok(re.test(`${PEDDLER_ORIGIN}/?index`)); route = f; },
    goto: async () => ({ status: () => 200 }), url: () => url, bringToFront: async () => {},
    waitForTimeout: ms => new Promise(r => setTimeout(r, Math.min(5, ms))),
    locator: s => ({ first: () => ({ inputValue: async () => value,
      click: async () => { assert.ok(s.endsWith('button[type="submit"]')); if (clickFails) throw new Error('covered'); await submit(); } }) }),
    evaluate: async () => { if (clickFails) await submit(); }, frames: () => [], mouse: { click: async () => { state.clicks++; } },
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => {} };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, handlers };
}

test('takes only the form page for one whole number with its own data capture', () => {
  assert.equal(peddlerBrowserNumber(url, capture), number);
  for (const u of [url.replace('https:', 'http:'), url + '&x=1', url.replace('track.pdlr.nl', 'example.test'), `${PEDDLER_ORIGIN}/trackntrace/${number}`,
    peddlerPageUrl('nlexp0012345678intped'), peddlerPageUrl('NLEXP 001')]) assert.equal(peddlerBrowserNumber(u, capture), null);
  assert.equal(peddlerBrowserNumber(url, { captureResponses: [peddlerLoaderUrl('P123456789012345678')] }), null);
  assert.equal(peddlerBrowserNumber(url, { captureResponses: [loader, loader] }), null);
});

test('binds the submit and the data request to the whole number', () => {
  const page = { mainFrame: () => frame };
  assert.equal(boundPeddlerAction(action(), number, page), true);
  for (const r of [action({ method: () => 'GET' }), action({ postData: () => form('NLEXP0012345679INTPED') }), action({ postData: () => form(number, '') }),
    action({ url: () => `${PEDDLER_ORIGIN}/?index=&inquiryNumber=X${number}` }), action({ frame: () => ({}) })]) assert.equal(boundPeddlerAction(r, number, page), false);
  assert.equal(boundPeddlerLoader(load(), number, page), true);
  for (const r of [load({ url: () => loader + '&x=1' }), load({ method: () => 'POST' }), load({ frame: () => ({}) })]) assert.equal(boundPeddlerLoader(r, number, page), false);
});

test('passes on tracking fields only', () => {
  const x = JSON.parse(projectPeddlerReply(payload));
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(x).includes('gps'), false);
  assert.deepEqual(x.data.package.events[0], { code: 603, status: 'FAILED_ATTEMPT', ts: '2026-03-16T15:10:04.239Z', failedStatus: 'INCOMPLETE_ADDRESS',
    details: { lang: { en: { headline: 'Delivery attempt failed', description: 'At destination' } } }, lang: { en: 'Incomplete address' } });
  assert.deepEqual(JSON.parse(projectPeddlerReply({ error: 'Consignment not found', ENV: { KEY: 'PRIVATE' } })), { error: 'Consignment not found' });
  assert.deepEqual(JSON.parse(projectPeddlerReply({ data: { inquiryNumber: number } })), { data: { inquiryNumber: number } });
  for (const x of [null, [], 'x']) assert.equal(projectPeddlerReply(x), 'null');
  assert.equal(JSON.parse(projectPeddlerReply({ data: { inquiryNumber: number, package: { events: {} } } })).data.package.events, null);
});

test('submits once the page holds its token and captures the bound reply', async () => {
  const f = fixture(); const r = await runPeddlerBrowser(f.options);
  assert.equal(r.reason, 'peddler-reply'); assert.equal(f.state.submits, 1); assert.equal(f.state.aborted, 0);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.state.policy, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('submits through the form itself when something covers its button', async () => {
  const r = await runPeddlerBrowser(fixture({ clickFails: true }).options);
  assert.equal(r.reason, 'peddler-reply');
});

test('keeps an unknown number’s 404 reply', async () => {
  const r = await runPeddlerBrowser(fixture({ status: 404, body: JSON.stringify({ error: 'Consignment not found', ENV: {} }) }).options);
  assert.equal(r.capturedResponses[0].status, 404); assert.equal(r.capturedResponses[0].body, '{"error":"Consignment not found"}');
});

test('reports a refused token, and a widget that never gave one', async () => {
  const refused = fixture({ actionStatus: 400, timeout: 400 }); const r = await runPeddlerBrowser(refused.options);
  assert.equal(r.reason, 'peddler-verification_refused'); assert.equal(r.capturedResponses.length, 0); assert.equal(refused.state.closed, 1);
  const blank = fixture({ token: '', timeout: 300 }); const b = await runPeddlerBrowser(blank.options);
  assert.equal(b.reason, 'peddler-verification_unfinished'); assert.equal(blank.state.submits, 0); assert.equal(blank.state.closed, 1);
});

test('leaves other pages to the generic tiers', async () => {
  assert.equal(await runPeddlerBrowser({ ...fixture().options, url: `${PEDDLER_ORIGIN}/` }), undefined);
});

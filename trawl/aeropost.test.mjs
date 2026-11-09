import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aeropostBrowserNumber, aeropostRequestMatches, projectAeropostTracking, runAeropostBrowser } from './aeropost-browser.mjs';
const number = 'CR7420873058', api = 'https://aeropost.com/api/tracking';
const url = `https://aeropost.com/en/tracking/${number}`, capture = { captureResponses: [api] };
const payload = { events: [{ code: 1000, status: 'Proof of Delivery', date_time: '2025-02-10 15:20:00', country_code: 'CR', private: 'PRIVATE' }], token: 'PRIVATE' };
function fixture() {
  const handlers = {}, state = { closed: 0, continued: 0, aborted: 0, navigated: 0 }, frame = { url: () => url };
  const request = (body = {}, overrides = {}) => ({ url: () => api, method: () => 'POST', frame: () => frame,
    postData: () => JSON.stringify({ trackingId: number, gateway: '', language: 'en', isCourier: false, recaptchaToken: 'PRIVATE', ...body }), ...overrides });
  const response = (req, status = 200, body = payload, headers = {}) => ({ request: () => req, url: req.url, status: () => status,
    headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'PRIVATE', ...headers }), body: async () => Buffer.from(JSON.stringify(body)) });
  const intercepted = req => ({ request: () => req, continue: async () => { state.continued++; }, abort: async () => { state.aborted++; } });
  const page = { mainFrame: () => frame, on: (n, h) => { handlers[n] = h; }, off: n => { delete handlers[n]; },
    route: async (_, route) => { state.route = route; }, goto: async () => {
      state.navigated++; const req = request(); await state.route(intercepted(req)); handlers.response(response(req)); return { status: () => 200 };
    } };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { state, handlers, page, request, response, intercepted, context,
    options: { url, capture, tier: 3, maxTimeout: 2000, handle: { browser: { newContext: async () => context } } } };
}
test('Aeropost accepts only one exact shipper page and endpoint', () => {
  assert.equal(aeropostBrowserNumber(url, capture), number);
  for (const other of [url+'?x=1', url+'#x', url.replace('/en/', '/es/'), url.replace(number, number+'9'), url.replace('aeropost.com','u@aeropost.com')]) assert.equal(aeropostBrowserNumber(other, capture), null);
  assert.equal(aeropostBrowserNumber(url, { captureResponses: [api, api] }), null);
  const f = fixture(); assert.equal(aeropostRequestMatches(f.request(), f.page, number), true);
  for (const req of [f.request({ trackingId: number+'9' }), f.request({ isCourier: true }), f.request({ gateway: 'SJO' }),
    f.request({ recaptchaToken: '' }), f.request({}, { method: () => 'GET' }), f.request({}, { frame: () => ({ url: () => url }) })]) assert.equal(aeropostRequestMatches(req, f.page, number), false);
});
test('Aeropost observes before navigation, projects bounded history and cleans a fresh context', async () => {
  const f = fixture(), answer = await runAeropostBrowser(f.options);
  assert.equal(answer.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(JSON.stringify(answer).includes('PRIVATE'), false); assert.equal(answer.html, ''); assert.deepEqual(answer.cookies, []);
  assert.equal(JSON.parse(answer.capturedResponses[0].body).events.length, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});
test('Aeropost caps whole-number native reads and refuses courier, other-number and excessive requests', async () => {
  const f = fixture(); f.page.goto = async () => {
    for (const req of [f.request({ trackingId: number+'9' }),f.request({ isCourier: true }),f.request(),f.request(),f.request()]) await f.state.route(f.intercepted(req));
    f.handlers.response(f.response(f.request()));
    f.handlers.requestfailed(f.request());
    return { status: () => 200 };
  };
  await runAeropostBrowser({ ...f.options, signal: AbortSignal.timeout(20) });
  assert.equal(f.state.continued, 2); assert.equal(f.state.aborted, 3); assert.equal(f.state.closed, 1);
});
test('Aeropost retains refused, accepted and rate-limited replies in order without reading challenge tokens', async () => {
  const f = fixture(); f.page.goto = async () => {
    const first = f.request(); await f.state.route(f.intercepted(first)); f.handlers.response(f.response(first, 403));
    const second = f.request(); await f.state.route(f.intercepted(second)); f.handlers.response(f.response(second, 429, null, { 'retry-after': '10' }));
  };
  const answer = await runAeropostBrowser(f.options); assert.deepEqual(answer.capturedResponses.map(r => r.status), [403,429]);
  assert.equal(answer.capturedResponses[1].headers['retry-after'], '10'); assert.equal(answer.capturedResponses[0].body, null);
});
test('Aeropost preserves the specific native missing signature and malformed shape while dropping stacks', () => {
  assert.deepEqual(projectAeropostTracking({ statusCode: 404, statusMessage: 'Tracking information not found', stack: 'PRIVATE' }), { statusCode: 404, statusMessage: 'Tracking information not found' });
  assert.deepEqual(projectAeropostTracking({ events: [null] }), { events: [null] });
  assert.deepEqual(projectAeropostTracking({ events: Array.from({ length: 501 }, () => payload.events[0]) }), { events: null });
  assert.deepEqual(projectAeropostTracking({ events: [{ ...payload.events[0], code: {} }] }).events[0].code, null);
});
test('Aeropost reserves cleanup, rejects tiny budgets and closes cancelled or late contexts', async () => {
  const tiny=fixture(); await runAeropostBrowser({ ...tiny.options, maxTimeout: 1000 }); assert.equal(tiny.state.navigated, 0);
  const hung=fixture(); hung.page.goto=()=>new Promise(()=>{}); await runAeropostBrowser({ ...hung.options, signal: AbortSignal.timeout(10) }); assert.equal(hung.state.closed,1);
  const late=fixture(); let release; late.options.handle.browser.newContext=()=>new Promise(resolve=>{release=resolve;});
  await runAeropostBrowser({ ...late.options, signal: AbortSignal.timeout(10) }); release(late.context);
  await new Promise(resolve=>setTimeout(resolve,10)); assert.equal(late.state.closed,1); assert.equal(late.state.navigated,0);
});

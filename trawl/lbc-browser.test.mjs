import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lbcBrowserNumber, runLbcBrowser } from './lbc-browser.mjs';
import { projectLbcTracking } from './tracking-capture.mjs';
const number = '199999999977', api = 'https://www.lbcexpress.com/wp-admin/admin-ajax.php';
const url = `https://www.lbcexpress.com/track/?tracking-number=${number}`, capture = { captureResponses: [api] };
const payload = () => JSON.parse(readFileSync(new URL('../carriers/lbc-express/fixtures/website.json', import.meta.url), 'utf8'));
const status = root => root.data.Body.LBCTrackAndTraceResponse.LBCTrackAndTraceResult.TrackingStatus;
function fixture() {
  const handlers = {}, state = { closed: 0, navigated: 0 }, frame = { url: () => url };
  const request = (value = number, overrides = {}) => ({ url: () => api, method: () => 'POST', frame: () => frame,
    postData: () => `action=track_package&security=PRIVATE_NONCE&trackingNumber=${value}`, ...overrides });
  const response = (req, status = 200, overrides = {}) => ({ request: () => req, url: req.url, status: () => status,
    headers: () => ({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'PRIVATE' }),
    body: async () => Buffer.from(JSON.stringify(payload())), ...overrides });
  const page = { mainFrame: () => frame, on: (name, handler) => { handlers[name] = handler; }, off: name => { delete handlers[name]; },
    goto: async () => { state.navigated++; const req = request(); handlers.request(req); handlers.response(response(req)); return { status: () => 200 }; } };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { handlers, state, page, context, request, response, options: { url, capture, tier: 3, maxTimeout: 100,
    handle: { browser: { newContext: async () => context } } } };
}
test('LBC accepts only its exact guest link and one tracking endpoint', () => {
  assert.equal(lbcBrowserNumber(url, capture), number);
  for (const other of [url + '&tracking-number=X', url + '#x', url.replace('/track/', '/account/'),
    url.replace('www.lbcexpress.com', 'example.test'), url.replace('www.lbcexpress.com', 'user@www.lbcexpress.com'), url.replace(number, number + '9')]) assert.equal(lbcBrowserNumber(other, capture), null);
  assert.equal(lbcBrowserNumber(url, { captureResponses: [api, api] }), null);
});
test('LBC decodes compressed history and keeps only selected fields, never the rendered page', async () => {
  const f = fixture(), result = await runLbcBrowser(f.options);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(status(JSON.parse(result.capturedResponses[0].body)).TrackingHistory.TrackingHistory.length, 3);
  assert.equal(result.html, ''); assert.equal(result.body.length, 0); assert.deepEqual(result.cookies, []);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});
test('LBC ignores other numbers, duplicate parameters, methods, frames and redirected documents', async () => {
  const f = fixture();
  f.page.goto = async () => {
    const bad = [f.request(number + '9'), f.request(number, { method: () => 'GET' }),
      f.request(number, { frame: () => ({ url: () => url }) }),
      f.request(number, { postData: () => `action=track_package&trackingNumber=${number}&trackingNumber=${number}` }),
      f.request(number, { postData: () => `action=track_package&action=other&trackingNumber=${number}` }),
      f.request(number, { frame: () => ({ url: () => 'https://www.lbcexpress.com/account/' }) })];
    for (const req of bad) f.handlers.response(f.response(req));
    const good = f.request(); f.handlers.request(good); f.handlers.response(f.response(good));
  };
  const result = await runLbcBrowser(f.options); assert.equal(result.capturedResponses.length, 1);
});
test('LBC retains an initial refusal, automatic accepted retry and a later rate limit in order', async () => {
  const f = fixture();
  f.page.goto = async () => {
    const first = f.request(); f.handlers.request(first); f.handlers.response(f.response(first, 403, { body: () => { throw Error('must not read'); } }));
    const second = f.request(); f.handlers.request(second); f.handlers.response(f.response(second));
    const last = f.request(); f.handlers.request(last);
    await new Promise(resolve => setTimeout(resolve, 10));
    f.handlers.response(f.response(last, 429, { headers: () => ({ 'retry-after': '45' }) }));
    return { status: () => 403 };
  };
  const result = await runLbcBrowser(f.options);
  assert.deepEqual(result.capturedResponses.map(row => row.status), [403, 200, 429]);
  assert.equal(result.capturedResponses.at(-1).headers['retry-after'], '45'); assert.equal(result.statusCode, 200);
});
test('LBC preserves wrong identities and schema errors without returning unprojected data', async () => {
  const f = fixture(), data = payload(); status(data).TrackingDetails.TrackingDetails.TrackingNo = number + '9';
  f.page.goto = async () => {
    const first = f.request(); f.handlers.request(first); f.handlers.response(f.response(first, 200, { body: async () => Buffer.from(JSON.stringify(data)) }));
    const last = f.request(); f.handlers.request(last); f.handlers.response(f.response(last, 200, { body: async () => Buffer.from('PRIVATE_BAD_JSON') }));
  };
  const result = await runLbcBrowser(f.options); assert.equal(result.capturedResponses[1].body, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(status(JSON.parse(result.capturedResponses[0].body)).TrackingDetails.TrackingDetails.TrackingNo, number + '9');
});
test('LBC bounds declared and decoded bytes and response count', async () => {
  for (const mode of ['declared', 'decoded', 'count']) {
    const f = fixture(); f.page.goto = async () => {
      const req = f.request(); f.handlers.request(req);
      if (mode === 'count') { for (let i = 0; i < 11; i++) f.handlers.response(f.response(req, 403)); return; }
      f.handlers.response(f.response(req, 200, { headers: () => mode === 'declared' ? { 'content-length': '1000001' } : {},
        body: async () => { assert.notEqual(mode, 'declared'); return Buffer.from('x'.repeat(1000001)); } }));
    };
    const result = await runLbcBrowser(f.options), last = result.capturedResponses.at(-1);
    assert.ok(result.capturedResponses.length <= 10);
    if (mode === 'count') assert.equal(last.error, 'response-limit'); else assert.equal(last.truncated, true);
  }
});
test('LBC does not conceal an unfinished later request behind earlier history', async () => {
  const f = fixture(); f.page.goto = async () => {
    const first = f.request(); f.handlers.request(first); f.handlers.response(f.response(first)); f.handlers.request(f.request());
  };
  const result = await runLbcBrowser({ ...f.options, maxTimeout: 15 });
  assert.equal(result.capturedResponses.at(-1).error, 'tracking-request-unfinished'); assert.equal(result.capturedResponses.at(-1).status, 0);
});
test('LBC cancellation closes hung and late contexts and retains a refused lookup', async () => {
  const f = fixture(); f.page.goto = async () => { const req = f.request(); f.handlers.request(req); f.handlers.response(f.response(req, 403)); };
  const result = await runLbcBrowser({ ...f.options, maxTimeout: 10 }); assert.equal(result.capturedResponses[0].status, 403); assert.equal(f.state.closed, 1);
  const hung = fixture(); hung.page.goto = () => new Promise(() => {});
  await runLbcBrowser({ ...hung.options, signal: AbortSignal.timeout(10) }); assert.equal(hung.state.closed, 1);
  const late = fixture(); let release; late.options.handle.browser.newContext = () => new Promise(resolve => { release = resolve; });
  await runLbcBrowser({ ...late.options, maxTimeout: 5 }); release(late.context);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(late.state.closed, 1); assert.equal(late.state.navigated, 0);
});
test('LBC projection preserves faults and malformed shapes while dropping private fields', () => {
  assert.deepEqual(projectLbcTracking({ success: true, data: { Body: { Fault: { message: 'PRIVATE' } } } }), { success: true, data: { Body: { Fault: {} } } });
  for (const root of [null, [], 'PRIVATE', { success: 'PRIVATE' }]) assert.deepEqual(projectLbcTracking(root), {});
  const broken = payload(); status(broken).TrackingDetails.TrackingDetails.TrackingNo = { private: number };
  assert.equal(status(projectLbcTracking(broken)).TrackingDetails.TrackingDetails.TrackingNo, null);
  status(broken).TrackingHistory.TrackingHistory = Array.from({ length: 501 }, () => ({}));
  assert.deepEqual(status(projectLbcTracking(broken)).TrackingHistory.TrackingHistory, [null]);
});

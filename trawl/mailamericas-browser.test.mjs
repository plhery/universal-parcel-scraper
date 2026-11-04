import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailamericasBrowserNumber, projectMailamericas, runMailamericasBrowser } from './mailamericas-browser.mjs';
const number = 'MLAR000000002EX', api = 'https://mailamericas.com/api/tracking';
const url = `https://mailamericas.com/tracking?number_id=${number}`, capture = { captureResponses: [api] };
const payload = { data: { trackingNumber: number, status: 'delivered', buyerName: 'PRIVATE', proof: 'PRIVATE',
  events: [{ date: '2026-01-02', time: '10:20', code: 'PF-1', status: 'Finished', description: 'Delivered by PRIVATE', proof: 'PRIVATE' }] } };
const request = (value = number, address = api, method = 'POST') => ({ url: () => address, method: () => method, postDataJSON: () => ({ trackingNumber: value }) });
const response = (req, status = 200, overrides = {}) => ({ request: () => req, url: req.url, status: () => status,
  headers: () => ({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'PRIVATE' }),
  body: async () => Buffer.from(JSON.stringify(payload)), ...overrides });
function fixture() {
  const handlers = {}, state = { closed: 0, navigated: 0 };
  const page = { on: (name, handler) => { handlers[name] = handler; }, off: name => { delete handlers[name]; },
    goto: async () => { state.navigated++; const req = request(); handlers.request(req); handlers.response(response(req)); return { status: () => 200 }; } };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { handlers, state, page, context, options: { url, capture, tier: 3, maxTimeout: 100,
    handle: { browser: { newContext: async () => context } } } };
}
test('only the exact carrier page, whole identifier and single capture endpoint activate the helper', () => {
  assert.equal(mailamericasBrowserNumber(url, capture), number);
  for (const other of [url + '&number_id=X', url + '#x', url.replace('mailamericas.com', 'example.test'),
    url.replace('mailamericas.com', 'user@mailamericas.com'), url.replace(number, number + '%20')]) assert.equal(mailamericasBrowserNumber(other, capture), null);
  assert.equal(mailamericasBrowserNumber(url, { captureResponses: [api, api] }), null);
});
test('captures decoded tracking, strips private fields and closes the fresh context', async () => {
  const f = fixture(), result = await runMailamericasBrowser(f.options);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(JSON.parse(result.capturedResponses[0].body).data.events.length, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
  assert.deepEqual(projectMailamericas({ data: null }), { data: null });
  assert.deepEqual(projectMailamericas({ data: null, error: 'PRIVATE' }), { data: null, error: true });
});
test('ignores requests for another item or endpoint and observes challenge then retry', async () => {
  const f = fixture();
  f.page.goto = async () => {
    for (const req of [request(number + 'X'), request(number, api + '?other'), request(number, api, 'GET')]) f.handlers.response(response(req));
    const first = request(); f.handlers.request(first); f.handlers.response(response(first, 202, { headers: () => ({ 'x-amzn-waf-action': 'challenge' }), body: () => { throw new Error('must not read challenge'); } }));
    const second = request(); f.handlers.request(second); f.handlers.response(response(second));
  };
  const result = await runMailamericasBrowser(f.options);
  assert.deepEqual(result.capturedResponses.map(r => r.status), [202, 200]);
  assert.equal(result.capturedResponses[0].body, null);
});
test('a pending later reply wins over an earlier history, including a refusal', async () => {
  const f = fixture();
  f.page.goto = async () => {
    const first = request(), last = request();
    f.handlers.request(first); f.handlers.response(response(first)); f.handlers.request(last);
    await new Promise(resolve => setTimeout(resolve, 10)); f.handlers.response(response(last, 429));
  };
  const result = await runMailamericasBrowser(f.options);
  assert.deepEqual(result.capturedResponses.map(r => r.status), [200, 429]);
});
test('bounds decompressed bodies, changed JSON and retained response counts', async () => {
  for (const mode of ['declared', 'decoded', 'json', 'count']) {
    const f = fixture();
    f.page.goto = async () => {
      const req = request(); f.handlers.request(req);
      if (mode === 'count') { for (let i = 0; i < 11; i++) f.handlers.response(response(req, 202)); return; }
      f.handlers.response(response(req, 200, { headers: () => mode === 'declared' ? { 'content-length': '524289' } : {},
        body: async () => { assert.notEqual(mode, 'declared'); return Buffer.from(mode === 'decoded' ? 'x'.repeat(524289) : '<html>PRIVATE</html>'); } }));
    };
    const result = await runMailamericasBrowser(f.options), last = result.capturedResponses.at(-1);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    if (mode === 'declared' || mode === 'decoded') assert.equal(last.truncated, true);
    else assert.ok(last.error);
    assert.ok(result.capturedResponses.length <= 10);
  }
});
test('an unfinished later request cannot expose an earlier successful history as the final answer', async () => {
  const f = fixture();
  f.page.goto = async () => {
    const first = request(); f.handlers.request(first); f.handlers.response(response(first));
    f.handlers.request(request());
  };
  const result = await runMailamericasBrowser({ ...f.options, maxTimeout: 15 });
  assert.equal(result.capturedResponses.at(-1).error, 'tracking-request-unfinished');
  assert.equal(result.capturedResponses.at(-1).status, 0);
});
test('retains a challenge on timeout, cancels hung navigation and closes late contexts', async () => {
  const f = fixture(); f.page.goto = async () => { const req = request(); f.handlers.request(req); f.handlers.response(response(req, 202)); };
  const result = await runMailamericasBrowser({ ...f.options, maxTimeout: 10 });
  assert.equal(result.capturedResponses[0].status, 202); assert.equal(f.state.closed, 1);
  const hung = fixture(); hung.page.goto = () => new Promise(() => {});
  await runMailamericasBrowser({ ...hung.options, signal: AbortSignal.timeout(10) }); assert.equal(hung.state.closed, 1);
  const late = fixture(); let release;
  late.options.handle.browser.newContext = () => new Promise(resolve => { release = resolve; });
  await runMailamericasBrowser({ ...late.options, maxTimeout: 5 }); release(late.context);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(late.state.closed, 1); assert.equal(late.state.navigated, 0);
});

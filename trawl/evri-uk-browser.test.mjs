import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evriUkBrowserNumber, evriUkRequestInfo, projectEvriUkSearch, projectEvriUkHistory, runEvriUkBrowser } from './evri-uk-browser.mjs';

const number = 'H000000000000001', urn = 'urn:parcel_id:barcode:date:123456:' + number + ':2026-01-03';
const url = 'https://www.evri.com/track/parcel/' + number + '/details';
const searchUrl = 'https://api.evri.com/customer-tracking/v1/search/' + number;
const historyBase = 'https://tracking.platform-apis.evri.com/v1/parcels';
const historyUrl = historyBase + '?' + new URLSearchParams({ uniqueIds: urn });
const capture = { captureResponses: [searchUrl, historyBase] };
const history = () => JSON.parse(readFileSync(new URL('../carriers/evri-uk/fixtures/history.json', import.meta.url), 'utf8'));
const search = () => ({ parcels: [{ brand: { name: 'EVRI' }, identifiers: [
  { type: 'PARCEL_ID', value: '123456' }, { type: 'BARCODE', value: number },
] }] });

function fixture() {
  const handlers = {}, state = { closed: 0, navigated: 0 }, frame = { url: () => url };
  const request = (target = searchUrl, overrides = {}) => ({ url: () => target, method: () => 'GET', frame: () => frame, ...overrides });
  const response = (req, data = search(), status = 200, overrides = {}) => ({ request: () => req, url: req.url, status: () => status,
    headers: () => ({ 'content-type': 'application/json', 'content-encoding': 'gzip', 'set-cookie': 'PRIVATE_COOKIE' }),
    body: async () => Buffer.from(JSON.stringify(data)), ...overrides });
  const emit = (target, data, status = 200, overrides = {}) => {
    const req = request(target); handlers.request(req); handlers.response(response(req, data, status, overrides)); return req;
  };
  const page = { mainFrame: () => frame, on: (event, fn) => { handlers[event] = fn; }, off: event => { delete handlers[event]; },
    goto: async () => { state.navigated++; emit(searchUrl, search()); emit(historyUrl, history()); return { status: () => 200 }; } };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { handlers, state, frame, page, context, request, response, emit, options: { url, capture, tier: 3, maxTimeout: 100,
    handle: { browser: { newContext: async () => context } } } };
}

test('Evri accepts only the exact guest deep link and both requested API endpoints', () => {
  assert.equal(evriUkBrowserNumber(url, capture), number);
  for (const other of [url + '?x=1', url + '#x', url + '/', url.replace('/track/parcel/', '/account/'),
    url.replace('www.evri.com', 'example.test'), url.replace('www.evri.com', 'user@www.evri.com')]) {
    assert.equal(evriUkBrowserNumber(other, capture), null);
  }
  assert.equal(evriUkBrowserNumber(url, { captureResponses: [historyBase, searchUrl] }), null);
  assert.equal(evriUkBrowserNumber(url, { captureResponses: [...capture.captureResponses, searchUrl] }), null);
});

test('Evri request binding uses a single whole barcode and one whole URN', () => {
  assert.equal(evriUkRequestInfo(searchUrl, number).kind, 'search');
  assert.equal(evriUkRequestInfo(historyUrl, number).urn, urn);
  for (const other of [searchUrl + '9', searchUrl + '?x=1', historyUrl + '&uniqueIds=' + urn, historyUrl + '&x=1',
    historyUrl.replace('tracking.platform-apis.evri.com', 'example.test'),
    historyBase + '?' + new URLSearchParams({ uniqueIds: urn.replace(number, number + '9') })]) {
    assert.equal(evriUkRequestInfo(other, number), null);
  }
});

test('Evri reads decoded unknown-length bodies and returns selected data without page/cookies', async () => {
  const f = fixture(), result = await runEvriUkBrowser(f.options);
  assert.equal(result.capturedResponses.length, 2);
  assert.ok(result.capturedResponses.every(row => row.trackingNumberSubmitted === number && row.body));
  assert.equal(JSON.parse(result.capturedResponses[1].body).results[0].uniqueId, urn);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(result.html, ''); assert.equal(result.body.length, 0); assert.deepEqual(result.cookies, []);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('Evri ignores other methods, frames, documents and barcodes before reading a body', async () => {
  const f = fixture();
  f.page.goto = async () => {
    for (const req of [f.request(searchUrl + '9'), f.request(searchUrl, { method: () => 'POST' }),
      f.request(searchUrl, { frame: () => ({ url: () => url }) }),
      f.request(searchUrl, { frame: () => ({ url: () => 'https://www.evri.com/account' }) })]) {
      f.handlers.response(f.response(req, undefined, 200, { body: () => { throw Error('must not read'); } }));
    }
    f.emit(searchUrl, search()); f.emit(historyUrl, history()); return { status: () => 200 };
  };
  assert.equal((await runEvriUkBrowser(f.options)).capturedResponses.length, 2);
});

test('Evri preserves refused search, automatic accepted retry and later history refusal in order', async () => {
  const f = fixture(); f.page.goto = async () => {
    f.emit(searchUrl, undefined, 403, { body: () => { throw Error('must not read'); } });
    f.emit(searchUrl, search()); f.emit(historyUrl, history());
    const req = f.request(historyUrl); f.handlers.request(req);
    await new Promise(resolve => setTimeout(resolve, 10));
    f.handlers.response(f.response(req, undefined, 429, { headers: () => ({ 'retry-after': '45' }) }));
    return { status: () => 403 };
  };
  const result = await runEvriUkBrowser(f.options);
  assert.deepEqual(result.capturedResponses.map(row => row.status), [403, 200, 200, 429]);
  assert.equal(result.capturedResponses.at(-1).headers['retry-after'], '45');
});

test('Evri retains a soft WAF wall and lets the page retry without exposing its HTML', async () => {
  const f = fixture(); f.page.goto = async () => {
    f.emit(searchUrl, undefined, 200, { body: async () => Buffer.from('<html>Verify you are human PRIVATE_PROOF</html>') });
    f.emit(searchUrl, search()); f.emit(historyUrl, history()); return { status: () => 200 };
  };
  const result = await runEvriUkBrowser(f.options);
  assert.equal(result.capturedResponses[0].error, 'verification-required');
  assert.equal(result.capturedResponses[0].body, null);
  assert.equal(result.capturedResponses.at(-1).status, 200);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('Evri keeps pending later history explicit instead of returning stale success', async () => {
  const f = fixture(); f.page.goto = async () => {
    f.emit(searchUrl, search()); f.emit(historyUrl, history()); f.handlers.request(f.request(historyUrl));
  };
  const result = await runEvriUkBrowser({ ...f.options, maxTimeout: 15 });
  assert.equal(result.capturedResponses.at(-1).status, 0);
  assert.equal(result.capturedResponses.at(-1).error, 'tracking-request-unfinished');
});

test('Evri projects empty/ambiguous/redirected search distinctly and strips private fields', () => {
  assert.deepEqual(projectEvriUkSearch({ parcels: [] }), { parcels: [] });
  assert.deepEqual(projectEvriUkSearch({}), { invalid: true });
  const raw = search(); raw.parcels[0].contact = 'PRIVATE'; raw.parcels[0].externalRedirectUrl = 'https://private.invalid';
  const projected = projectEvriUkSearch(raw); assert.equal(projected.parcels[0].externalRedirectUrl, 'redirected');
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
  raw.parcels[0].identifiers.push({ type: 'BARCODE', value: number + '9' });
  assert.equal(projectEvriUkSearch(raw).parcels[0].identifiers.at(-1).value, number + '9');
});

test('Evri history projection keeps binding and logistics data, never ownership or delivery prose', () => {
  const raw = history(), row = raw.results[0]; row.contact = 'PRIVATE'; row.ownershipToken = 'PRIVATE';
  const delivered = row.trackingEvents.find(event => event.trackingStage.trackingStageCode === '5_COURIER');
  if (delivered) delivered.trackingPoint.description = 'Delivered to PRIVATE PERSON';
  const projected = projectEvriUkHistory(raw);
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
  assert.equal(projected.results[0].trackingEvents.length, row.trackingEvents.length);
  assert.deepEqual(projectEvriUkHistory({ results: [], failures: [{ token: 'PRIVATE' }] }), { results: [], failures: [{}] });
  row.trackingEvents.push({ private: 'PRIVATE' }); assert.deepEqual(projectEvriUkHistory(raw), { invalid: true });
});

test('Evri bounds declared/decoded bytes, rows and response count', async () => {
  for (const mode of ['declared', 'decoded', 'count']) {
    const f = fixture(); f.page.goto = async () => {
      if (mode === 'count') { for (let i = 0; i < 11; i++) f.emit(searchUrl, undefined, 403); return; }
      f.emit(searchUrl, undefined, 200, { headers: () => mode === 'declared' ? { 'content-length': '2000001' } : {},
        body: async () => { assert.notEqual(mode, 'declared'); return Buffer.from('x'.repeat(2000001)); } });
    };
    const result = await runEvriUkBrowser(f.options), last = result.capturedResponses.at(-1);
    assert.ok(result.capturedResponses.length <= 10);
    if (mode === 'count') assert.equal(last.error, 'response-limit'); else assert.equal(last.truncated, true);
  }
  assert.deepEqual(projectEvriUkSearch({ parcels: Array(51).fill(search().parcels[0]) }), { invalid: true });
  const raw = history(); raw.results[0].trackingEvents = Array(501).fill(raw.results[0].trackingEvents[0]);
  assert.deepEqual(projectEvriUkHistory(raw), { invalid: true });
});

test('Evri cancellation closes hung and late contexts, retaining refusal metadata', async () => {
  const f = fixture(); f.page.goto = async () => { f.emit(searchUrl, undefined, 403); };
  const result = await runEvriUkBrowser({ ...f.options, maxTimeout: 10 });
  assert.equal(result.capturedResponses[0].status, 403); assert.equal(f.state.closed, 1);
  const hung = fixture(); hung.page.goto = () => new Promise(() => {});
  await runEvriUkBrowser({ ...hung.options, signal: AbortSignal.timeout(10) }); assert.equal(hung.state.closed, 1);
  const late = fixture(); let release; late.options.handle.browser.newContext = () => new Promise(resolve => { release = resolve; });
  await runEvriUkBrowser({ ...late.options, maxTimeout: 5 }); release(late.context);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(late.state.closed, 1);
});

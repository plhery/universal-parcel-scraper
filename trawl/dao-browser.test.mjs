import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DAO_API, DAO_CAPTURE_BYTES, daoApiUrl, daoBrowserNumber, boundDaoRequest, projectDaoReply,
  installDaoNativeBridge, runDaoBrowser } from './dao-browser.mjs';
const number = '00057151279999999993', url = `https://dao.as/en/track-your-parcel/#q=${number}`;
const capture = { captureResponses: [daoApiUrl(number)] }, frame = {};
const payload = { found: true, token: 'PRIVATE', parcel: { barcode: number, recipient: 'PRIVATE', pickup: { name: 'Shop', address: 'PRIVATE' },
  events: [{ raw: { tidspunkt: '2026-03-12 06:41:20', pakketype: 'Home', haendelse: '11', beskrivelse: 'Parcel delivered', sted: '', name: 'PRIVATE' } }] } };
const request = (extra = {}) => ({ method: () => 'GET', url: () => daoApiUrl(number), frame: () => frame, ...extra });
function fixture({ body = JSON.stringify(payload), status = 200, response = true, interactive = false, covered = false,
  width = 300, timeout = 1000, delay = 1, lateConsent = false } = {}) {
  const handlers = {}, state = { closed: 0, clicks: 0, read: 0, policy: 0, fallback: 0, aborted: 0, replacement: 0 };
  const reply = { request, status: () => status, headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'PRIVATE', 'retry-after': '60' }),
    body: async () => { state.read++; return Buffer.from(body); } };
  const emit = async () => {
    await state.route({ request: () => request(), fallback: async () => { state.fallback++; setTimeout(() => handlers.response?.(reply), delay); }, abort: async () => { state.aborted++; } });
  };
  let consentUp = lateConsent;
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    addInitScript: async f => { assert.equal(f, installDaoNativeBridge); }, route: async (re, f) => { assert.ok(re.test(daoApiUrl(number))); state.route = f; },
    goto: async () => { if (response && !interactive) await emit(); return { status: () => 200 }; }, url: () => url,
    bringToFront: async () => {}, waitForTimeout: ms => new Promise(r => setTimeout(r, Math.min(5, ms))),
    locator: s => ({ isVisible: async () => s === '#declineButton' && consentUp, click: async () => { consentUp = false; }, getAttribute: async () => JSON.stringify({ interactive, complete: false, code: null }),
      scrollIntoViewIfNeeded: async () => {} }),
    frames: () => [{ url: () => 'https://challenges.cloudflare.com/turnstile/widget', parentFrame: () => frame,
      frameElement: async () => ({ boundingBox: async () => ({ x: 10, y: 20, width, height: 65 }) }) }],
    evaluate: async () => !covered && !consentUp, mouse: { click: async () => { state.clicks++; if (response) await emit(); } },
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => { state.replacement++; } };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, page, context, handlers, reply };
}
test('scopes recovery to the canonical English page and exact whole-query capture', () => {
  assert.equal(daoBrowserNumber(url, capture), number);
  for (const u of [url.replace('https:', 'http:'), url + '&x=1', url + '&q=' + number, url.replace('/en/', '/'),
    url.replace('dao.as', 'example.test'), url.replace('dao.as', 'u@dao.as'), url.replace('/#q', '/?x=1#q')]) assert.equal(daoBrowserNumber(u, capture), null);
  assert.equal(daoBrowserNumber(url, { captureResponses: [DAO_API] }), null);
  assert.equal(daoBrowserNumber(url, { captureResponses: [daoApiUrl(number), daoApiUrl(number)] }), null);
  assert.equal(boundDaoRequest(request(), number, { mainFrame: () => frame }), true);
  for (const r of [request({ method: () => 'POST' }), request({ url: () => daoApiUrl(number) + '&x=1' }), request({ frame: () => ({}) })])
    assert.equal(boundDaoRequest(r, number, { mainFrame: () => frame }), false);
});
test('projects only identity, scans, pickup name and partner, preserving malformed fields', () => {
  const x = JSON.parse(projectDaoReply(payload)); assert.equal(x.parcel.barcode, number); assert.equal(x.parcel.events[0].raw.tidspunkt, '2026-03-12 06:41:20');
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.deepEqual(JSON.parse(projectDaoReply({ found: false })), { found: false });
  for (const x of [null, [], {}, { found: 'false' }]) assert.equal(projectDaoReply(x), 'null');
  assert.equal(JSON.parse(projectDaoReply({ found: true, parcel: { barcode: number, events: {} } })).parcel.events, null);
  assert.equal(JSON.parse(projectDaoReply({ found: true, parcel: { barcode: number, events: [{ raw: { tidspunkt: {} } }] } })).parcel.events[0].raw.tidspunkt, null);
});
test('observes before navigation, binds whole request, preserves outbound policy and closes', async () => {
  const f = fixture(); const r = await runDaoBrowser(f.options);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.state.policy, 1); assert.equal(f.state.fallback, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});
test('clicks only the exposed native interactive frame and waits for its asynchronous reply', async () => {
  const f = fixture({ interactive: true, delay: 20 }); const r = await runDaoBrowser(f.options);
  assert.equal(f.state.clicks, 1); assert.equal(r.capturedResponses.length, 1); assert.equal(f.state.closed, 1);
  for (const variant of [{ covered: true }, { width: 1000 }]) {
    const blocked = fixture({ ...variant, interactive: true, timeout: 70 });
    assert.equal((await runDaoBrowser(blocked.options)).capturedResponses.length, 0); assert.equal(blocked.state.clicks, 0);
  }
});
test('dismisses a consent dialog that appears after navigation before exposing the widget', async () => {
  const f = fixture({ interactive: true, lateConsent: true });
  const r = await runDaoBrowser(f.options); assert.equal(f.state.clicks, 1); assert.equal(r.capturedResponses.length, 1);
});
test('never clicks a pre-interactive widget or makes unlimited attempts', async () => {
  const f = fixture({ response: false, timeout: 70 }); assert.equal((await runDaoBrowser(f.options)).reason, 'dao-verification_unfinished'); assert.equal(f.state.clicks, 0);
  const g = fixture({ response: false, interactive: true, timeout: 70 }); await runDaoBrowser(g.options); assert.equal(g.state.clicks, 1);
});
test('retains challenge/rate-limit/upstream statuses without response cookies or bodies', async () => {
  for (const status of [403, 429, 500]) {
    const f = fixture({ status, body: 'PRIVATE' }); const r = await runDaoBrowser(f.options);
    assert.equal(r.capturedResponses[0].status, status); assert.equal(r.capturedResponses[0].headers['retry-after'], '60');
    assert.equal(f.state.read, 0); assert.equal(JSON.stringify(r).includes('PRIVATE'), false);
  }
});
test('keeps invalid JSON, blocked HTML and oversized bodies distinct', async () => {
  for (const [body, error, truncated] of [['bad', 'invalid-json', false], ['<title>Just a moment</title>', 'challenge-html', false],
    ['x'.repeat(DAO_CAPTURE_BYTES + 1), null, true]]) {
    const f = fixture({ body }); const r = await runDaoBrowser(f.options);
    assert.equal(r.capturedResponses[0].error, error); assert.equal(r.capturedResponses[0].truncated, truncated);
  }
});
test('cancels before opening and during verification and collects late contexts', async () => {
  const f = fixture(), c = new AbortController(); c.abort(); await assert.rejects(runDaoBrowser({ ...f.options, signal: c.signal }), { name: 'AbortError' }); assert.equal(f.state.closed, 0);
  const g = fixture({ response: false }), d = new AbortController(); const p = runDaoBrowser({ ...g.options, signal: d.signal }); setTimeout(() => d.abort(), 10);
  await assert.rejects(p, { name: 'AbortError' }); assert.equal(g.state.closed, 1); assert.deepEqual(g.handlers, {});
  const late = fixture({ timeout: 50 }); late.options.handle.browser.newContext = () => new Promise(r => setTimeout(() => r(late.context), 80));
  await runDaoBrowser(late.options); await new Promise(r => setTimeout(r, 80)); assert.equal(late.state.closed, 1); assert.equal(late.state.replacement, 1);
});
test('native bridge keeps only fixed state and numeric error codes on the DAO page', () => {
  let listener, script, state; const root = { appendChild: s => { script = s.textContent; }, setAttribute: (_, v) => { state = JSON.parse(v); } };
  const sandbox = { location: { origin: 'https://dao.as', pathname: '/en/track-your-parcel/' }, document: { documentElement: root, createElement: () => ({ remove() {} }) },
    window: { addEventListener: (_, f) => { listener = f; } } };
  vm.runInNewContext(`(${installDaoNativeBridge.toString()})()`, sandbox); vm.runInNewContext(script, sandbox);
  listener({ origin: 'https://evil.test', data: { event: 'interactiveBegin' } }); assert.equal(state, undefined);
  listener({ origin: 'https://challenges.cloudflare.com', data: { event: 'interactiveBegin', token: 'PRIVATE' } }); assert.equal(state.interactive, true);
  listener({ origin: 'https://challenges.cloudflare.com', data: { event: 'complete', token: 'PRIVATE' } }); assert.equal(state.interactive, false); assert.equal(state.complete, true);
  assert.equal(JSON.stringify(state).includes('PRIVATE'), false);
});

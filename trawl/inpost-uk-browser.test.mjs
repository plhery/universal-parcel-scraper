import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INPOST_UK_API, INPOST_UK_CAPTURE_BYTES, inpostUkPageUrl, inpostUkBrowserNumber, boundInpostUkRequest, projectInpostUkReply,
  installInpostUkNativeBridge, runInpostUkBrowser } from './inpost-uk-browser.mjs';
// Synthetic numbers in Yodel's layouts.
const number = `JJD${'0'.repeat(15)}1`, url = inpostUkPageUrl(number);
const capture = { captureResponses: [INPOST_UK_API] }, frame = {};
const payload = { status: 'ok', data: [{ mainTrackingNumber: number, status: 'IN_TRANSIT_LAST_MILE', statusTitle: 'Out for delivery',
  receiverName: 'PRIVATE', destination: { locationType: 'ADDRESS', countryCode: 'GB', postcode: 'PRIVATE', address: 'PRIVATE' },
  shipment: { type: 'STANDARD', sender: 'PRIVATE' }, deliveryTimeWindow: { startDatetime: '2026-03-12T10:00:00Z', endDatetime: '2026-03-12T11:00:00Z' },
  events: [{ eventCode: 'EOL.1001', eventTitle: 'We have your parcel', timestamp: '2026-03-12T06:41:20Z', status: 'IN_TRANSIT',
    location: { city: 'Example Town', countryCode: 'GB', postcode: 'PRIVATE' }, driver: 'PRIVATE' }] }] };
const post = (body = { trackingNumber: number, turnstileToken: 'token' }) => JSON.stringify(body);
const request = (extra = {}) => ({ method: () => 'POST', url: () => INPOST_UK_API, postData: () => post(), frame: () => frame, ...extra });
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
    addInitScript: async f => { assert.equal(f, installInpostUkNativeBridge); }, route: async (re, f) => { assert.ok(re.test(INPOST_UK_API)); state.route = f; },
    goto: async () => { if (response && !interactive) await emit(); return { status: () => 200 }; }, url: () => url,
    bringToFront: async () => {}, waitForTimeout: ms => new Promise(r => setTimeout(r, Math.min(5, ms))),
    locator: s => ({ isVisible: async () => s === '#CybotCookiebotDialogBodyButtonDecline' && consentUp, click: async () => { consentUp = false; },
      getAttribute: async () => JSON.stringify({ interactive, complete: false, code: null }), scrollIntoViewIfNeeded: async () => {} }),
    frames: () => [{ url: () => 'https://challenges.cloudflare.com/turnstile/widget', parentFrame: () => frame,
      frameElement: async () => ({ boundingBox: async () => ({ x: 10, y: 20, width, height: 65 }) }) }],
    evaluate: async () => !covered && !consentUp, mouse: { click: async () => { state.clicks++; if (response) await emit(); } },
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => { state.replacement++; } };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, page, context, handlers, reply };
}
test('scopes recovery to the result page of one number in Yodel’s layouts and its one post', () => {
  assert.equal(inpostUkBrowserNumber(url, capture), number);
  for (const other of [`JD${'0'.repeat(15)}1`, `8YDR${'0'.repeat(8)}1`, '12ABC0000000A001']) assert.equal(inpostUkBrowserNumber(inpostUkPageUrl(other), capture), other);
  for (const u of [url.replace('https:', 'http:'), url + '&x=1', url.replace('parcel_code', 'trackingNumber'), url.replace('/result', '/results'),
    url.replace('inpost.co.uk', 'example.test'), url.replace('inpost.co.uk', 'u@inpost.co.uk'), url + '#x', inpostUkPageUrl('6'.repeat(24)),
    inpostUkPageUrl(number.toLowerCase()), inpostUkPageUrl(`${number}0`)]) assert.equal(inpostUkBrowserNumber(u, capture), null);
  assert.equal(inpostUkBrowserNumber(url, { captureResponses: [INPOST_UK_API + '?x=1'] }), null);
  assert.equal(inpostUkBrowserNumber(url, { captureResponses: [INPOST_UK_API, INPOST_UK_API] }), null);
  const page = { mainFrame: () => frame };
  assert.equal(boundInpostUkRequest(request(), number, page), true);
  for (const r of [request({ method: () => 'GET' }), request({ url: () => INPOST_UK_API + '?x=1' }), request({ frame: () => ({}) }),
    request({ postData: () => post({ trackingNumber: `${number}0`, turnstileToken: 'token' }) }), request({ postData: () => post({ trackingNumber: number }) }),
    request({ postData: () => post({ trackingNumber: number, turnstileToken: '' }) }), request({ postData: () => post({ trackingNumber: number, turnstileToken: 'token', x: 1 }) }),
    request({ postData: () => 'not json' }), request({ postData: () => null })]) assert.equal(boundInpostUkRequest(r, number, page), false);
});
test('projects the parcel’s statuses, destination type and country, window and scans, without names, addresses or postcodes', () => {
  const x = JSON.parse(projectInpostUkReply(payload));
  assert.equal(x.status, 'ok'); assert.equal(x.data[0].mainTrackingNumber, number); assert.equal(x.data[0].events[0].eventCode, 'EOL.1001');
  assert.deepEqual(x.data[0].events[0].location, { city: 'Example Town', countryCode: 'GB' });
  assert.deepEqual(x.data[0].destination, { locationType: 'ADDRESS', countryCode: 'GB' });
  assert.equal(x.data[0].keys.includes('receiverName'), true); assert.equal(x.data[0].eventKeys.includes('driver'), true);
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.deepEqual(JSON.parse(projectInpostUkReply({ status: 'not_found', data: [] })), { status: 'not_found', data: [] });
  for (const bad of [null, [], {}, { status: 1 }, { status: 'x'.repeat(41) }]) assert.equal(projectInpostUkReply(bad), 'null');
  assert.equal(JSON.parse(projectInpostUkReply({ status: 'ok', data: {} })).data, null);
  assert.equal(JSON.parse(projectInpostUkReply({ status: 'ok', data: [{ events: {} }] })).data[0].events, null);
  assert.equal(JSON.parse(projectInpostUkReply({ status: 'ok', data: [{ events: [{ timestamp: {} }] }] })).data[0].events[0].timestamp, null);
});
test('observes before navigation, binds the whole post, keeps the outbound policy and closes', async () => {
  const f = fixture(); const r = await runInpostUkBrowser(f.options);
  assert.equal(r.reason, 'inpost-uk-reply'); assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(JSON.stringify(r).includes('token'), false);
  assert.equal(f.state.policy, 1); assert.equal(f.state.fallback, 1); assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});
test('keeps an unknown number’s 404 with its body', async () => {
  const f = fixture({ status: 404, body: JSON.stringify({ status: 'not_found', data: [] }) }); const r = await runInpostUkBrowser(f.options);
  assert.equal(r.capturedResponses[0].status, 404); assert.deepEqual(JSON.parse(r.capturedResponses[0].body), { status: 'not_found', data: [] });
});
test('clicks only the exposed interactive widget and waits for its asynchronous reply', async () => {
  const f = fixture({ interactive: true, delay: 20 }); const r = await runInpostUkBrowser(f.options);
  assert.equal(f.state.clicks, 1); assert.equal(r.capturedResponses.length, 1); assert.equal(f.state.closed, 1);
  for (const variant of [{ covered: true }, { width: 1000 }]) {
    const blocked = fixture({ ...variant, interactive: true, timeout: 70 });
    assert.equal((await runInpostUkBrowser(blocked.options)).capturedResponses.length, 0); assert.equal(blocked.state.clicks, 0);
  }
});
test('declines a cookie dialog that covers the widget before clicking it', async () => {
  const f = fixture({ interactive: true, lateConsent: true });
  const r = await runInpostUkBrowser(f.options); assert.equal(f.state.clicks, 1); assert.equal(r.capturedResponses.length, 1);
});
test('never clicks a widget that has not asked, and stops after bounded attempts', async () => {
  const f = fixture({ response: false, timeout: 70 }); assert.equal((await runInpostUkBrowser(f.options)).reason, 'inpost-uk-verification_unfinished'); assert.equal(f.state.clicks, 0);
  const g = fixture({ response: false, interactive: true, timeout: 70 }); await runInpostUkBrowser(g.options); assert.equal(g.state.clicks, 1);
});
test('keeps refused, rate-limited and failed statuses without cookies or bodies', async () => {
  for (const status of [403, 429, 500]) {
    const f = fixture({ status, body: 'PRIVATE' }); const r = await runInpostUkBrowser(f.options);
    assert.equal(r.capturedResponses[0].status, status); assert.equal(r.capturedResponses[0].headers['retry-after'], '60');
    assert.equal(f.state.read, 0); assert.equal(JSON.stringify(r).includes('PRIVATE'), false);
  }
});
test('keeps invalid JSON, blocked HTML and oversized bodies distinct', async () => {
  for (const [body, error, truncated] of [['bad', 'invalid-json', false], ['<title>Just a moment</title>', 'challenge-html', false],
    ['x'.repeat(INPOST_UK_CAPTURE_BYTES + 1), null, true]]) {
    const f = fixture({ body }); const r = await runInpostUkBrowser(f.options);
    assert.equal(r.capturedResponses[0].error, error); assert.equal(r.capturedResponses[0].truncated, truncated);
  }
});
test('cancels before opening and during verification and collects late contexts', async () => {
  const f = fixture(), c = new AbortController(); c.abort(); await assert.rejects(runInpostUkBrowser({ ...f.options, signal: c.signal }), { name: 'AbortError' }); assert.equal(f.state.closed, 0);
  const g = fixture({ response: false }), d = new AbortController(); const p = runInpostUkBrowser({ ...g.options, signal: d.signal }); setTimeout(() => d.abort(), 10);
  await assert.rejects(p, { name: 'AbortError' }); assert.equal(g.state.closed, 1); assert.deepEqual(g.handlers, {});
  const late = fixture({ timeout: 50 }); late.options.handle.browser.newContext = () => new Promise(r => setTimeout(() => r(late.context), 80));
  await runInpostUkBrowser(late.options); await new Promise(r => setTimeout(r, 80)); assert.equal(late.state.closed, 1); assert.equal(late.state.replacement, 1);
});
test('native bridge keeps only fixed state and numeric error codes on the result page', () => {
  let listener, script, state; const root = { appendChild: s => { script = s.textContent; }, setAttribute: (_, v) => { state = JSON.parse(v); } };
  const sandbox = { location: { origin: 'https://inpost.co.uk', pathname: '/tracking/result' }, document: { documentElement: root, createElement: () => ({ remove() {} }) },
    window: { addEventListener: (_, f) => { listener = f; } } };
  vm.runInNewContext(`(${installInpostUkNativeBridge.toString()})()`, sandbox); vm.runInNewContext(script, sandbox);
  listener({ origin: 'https://evil.test', data: { event: 'interactiveBegin' } }); assert.equal(state, undefined);
  listener({ origin: 'https://challenges.cloudflare.com', data: { event: 'interactiveBegin', token: 'PRIVATE' } }); assert.equal(state.interactive, true);
  listener({ origin: 'https://challenges.cloudflare.com', data: { event: 'complete', token: 'PRIVATE' } }); assert.equal(state.interactive, false); assert.equal(state.complete, true);
  assert.equal(JSON.stringify(state).includes('PRIVATE'), false);
});

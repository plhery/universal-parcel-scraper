import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAPAG_CAPTURE_BYTES, HAPAG_EVENTS, HAPAG_PAGE, boundHapagLookup, hapagBrowserNumber, hapagEventsUrl, hapagPageUrl,
  projectHapagReply, runHapagBrowser } from './hapag-lloyd-browser.mjs';

// Synthetic: the container's check digit fails.
const reference = 'ZZZU0000023', url = hapagPageUrl(reference), capture = { captureResponses: [hapagEventsUrl(reference)] }, frame = {};
const payload = { groups: [{ containerNumber: reference, containerType: 'PRIVATE', weight: 'PRIVATE', events: [
  { containerNumber: reference, eventDescription: 'Vessel departed', eventLocation: 'Bremerhaven', eventDate: '2026-01-08', eventTime: '22:15',
    eventTransport: 'Vessel', eventClassifierCode: 'Actual', voyage: 'PRIVATE', vesselName: 'PRIVATE' }] }] };
const lookup = (extra = {}) => ({ method: () => 'GET', url: () => hapagEventsUrl(reference), frame: () => frame, isNavigationRequest: () => false, ...extra });
const navigation = { method: () => 'GET', url: () => HAPAG_PAGE, frame: () => frame, isNavigationRequest: () => true };

function fixture({ body = JSON.stringify(payload), status = 200, pageStatus = 200, checkbox = false, covered = false, width = 300,
  respond = true, timeout = 1000, delay = 1, others = [] } = {}) {
  const handlers = {}, state = { closed: 0, clicks: 0, read: 0, policy: 0, fallback: 0, aborted: 0, replacement: 0, route: null };
  const reply = { request: () => lookup(), url: () => hapagEventsUrl(reference), status: () => status,
    headers: () => ({ 'content-type': 'application/json', 'set-cookie': 'PRIVATE', 'retry-after': '60', 'content-length': String(Buffer.byteLength(body)) }),
    body: async () => { state.read++; return Buffer.from(body); } };
  const page_ = status => ({ request: () => navigation, url: () => HAPAG_PAGE, status: () => status, headers: () => ({}) });
  const route = async request => state.route({ request: () => request,
    fallback: async () => { state.fallback++; setTimeout(() => handlers.response?.(reply), delay); },
    abort: async () => { state.aborted++; } });
  const lookups = async () => { for (const r of others) await route(r); await route(lookup()); };
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    route: async (re, f) => { assert.ok(re.test(hapagEventsUrl(reference))); assert.equal(re.test(HAPAG_PAGE), false); state.route = f; },
    goto: async target => { assert.equal(target, url); handlers.response?.(page_(checkbox ? pageStatus : 200)); if (respond && !checkbox) await lookups();
      return { status: () => checkbox ? pageStatus : 200 }; },
    bringToFront: async () => {}, waitForTimeout: ms => new Promise(r => setTimeout(r, Math.min(5, ms))),
    frames: () => [{ url: () => 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile', parentFrame: () => frame,
      frameElement: async () => ({ boundingBox: async () => ({ x: 10, y: 20, width, height: 65 }), evaluate: async () => checkbox && !covered }) }],
    mouse: { click: async (x, y) => { assert.deepEqual([x, y], [32, 52.5]); state.clicks++; handlers.response?.(page_(200)); if (respond) await lookups(); } },
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => { state.replacement++; } };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, handlers, context };
}

test('scopes recovery to the tracking page for a whole reference and its exact lookup', () => {
  assert.equal(hapagBrowserNumber(url, capture), reference);
  for (const ref of ['12345678', 'HLCUZZZ999999999']) assert.equal(hapagBrowserNumber(hapagPageUrl(ref), { captureResponses: [hapagEventsUrl(ref)] }), ref);
  for (const u of [url.replace('https:', 'http:'), url + '/x', url.replace('#/', '#'), url.replace('#/', '?x=1#/'), url.replace('www.', ''),
    url.replace('/tracking/', '/tracking/x/'), url.toLowerCase(), hapagPageUrl('ZZZU00000'), hapagPageUrl('123456789'), hapagPageUrl('')])
    assert.equal(hapagBrowserNumber(u, capture), null);
  for (const c of [{}, { captureResponses: [HAPAG_EVENTS] }, { captureResponses: [hapagEventsUrl(reference), hapagEventsUrl(reference)] },
    { captureResponses: [hapagEventsUrl('ZZZU0000012')] }]) assert.equal(hapagBrowserNumber(url, c), null);
  assert.equal(boundHapagLookup(lookup(), reference, { mainFrame: () => frame }), true);
  for (const r of [lookup({ method: () => 'POST' }), lookup({ url: () => hapagEventsUrl(reference) + '&x=1' }), lookup({ url: () => hapagEventsUrl('ZZZU0000012') }),
    lookup({ frame: () => ({}) })]) assert.equal(boundHapagLookup(r, reference, { mainFrame: () => frame }), false);
});

test('projects moves, places and means of transport only, keeping malformed fields visible', () => {
  const x = JSON.parse(projectHapagReply(payload));
  assert.deepEqual(x.groups[0].events[0], { containerNumber: reference, eventDescription: 'Vessel departed', eventLocation: 'Bremerhaven',
    eventDate: '2026-01-08', eventTime: '22:15', eventTransport: 'Vessel', eventClassifierCode: 'Actual' });
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.deepEqual(JSON.parse(projectHapagReply({ errorKey: 'dcsa.container-not-found', message: 'PRIVATE' })), { errorKey: 'dcsa.container-not-found' });
  for (const p of [null, [], 'x']) assert.equal(projectHapagReply(p), 'null');
  assert.equal(JSON.parse(projectHapagReply({ groups: {} })).groups, 'unreadable');
  assert.equal(JSON.parse(projectHapagReply({ groups: [{ events: {} }] })).groups[0].events, 'unreadable');
  assert.deepEqual(JSON.parse(projectHapagReply({ groups: [7, { events: [7, { eventDate: {} }] }] })).groups, [null, { events: [null, { eventDate: null }] }]);
});

test('observes before navigation, lets only the bound lookup out and closes its context', async () => {
  const other = lookup({ url: () => hapagEventsUrl('ZZZU0000012') });
  const f = fixture({ others: [other, lookup({ url: () => 'https://tracking.api.hlag.cloud/api/tracking/v3/config' })] });
  const r = await runHapagBrowser(f.options);
  assert.equal(r.reason, 'hapag-lloyd-reply'); assert.equal(r.statusCode, 200);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].url, hapagEventsUrl(reference));
  assert.equal(r.capturedResponses[0].trackingNumberSubmitted, reference);
  assert.equal(JSON.parse(r.capturedResponses[0].body).groups[0].events.length, 1);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false);
  assert.equal(f.state.aborted, 2); assert.equal(f.state.fallback, 1); assert.equal(f.state.policy, 1); assert.equal(f.state.clicks, 0);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('aborts a third lookup of the same reference', async () => {
  const f = fixture({ others: [lookup(), lookup()], delay: 20 }); const r = await runHapagBrowser(f.options);
  assert.equal(f.state.fallback, 2); assert.equal(f.state.aborted, 1); assert.equal(r.capturedResponses.length, 2);
});

test('clicks an exposed checkbox once, keeps the passed page status and waits for the reply', async () => {
  const f = fixture({ checkbox: true, pageStatus: 403, delay: 20 }); const r = await runHapagBrowser(f.options);
  assert.equal(f.state.clicks, 1); assert.equal(r.statusCode, 200); assert.equal(r.capturedResponses.length, 1); assert.equal(f.state.closed, 1);
});

test('never clicks a covered or misshapen checkbox and keeps the refused page status', async () => {
  for (const variant of [{ covered: true }, { width: 1000 }]) {
    const f = fixture({ ...variant, checkbox: true, pageStatus: 403, timeout: 80 }); const r = await runHapagBrowser(f.options);
    assert.equal(f.state.clicks, 0); assert.equal(r.capturedResponses.length, 0); assert.equal(r.statusCode, 403);
    assert.equal(r.reason, 'hapag-lloyd-capture_missing'); assert.equal(f.state.closed, 1);
  }
});

test('keeps a refusal\'s error key and the statuses of other answers without their bodies or cookies', async () => {
  const refusal = fixture({ status: 422, body: JSON.stringify({ errorKey: 'dcsa.container-not-found', detail: 'PRIVATE' }) });
  const r = await runHapagBrowser(refusal.options);
  assert.equal(r.capturedResponses[0].status, 422); assert.deepEqual(JSON.parse(r.capturedResponses[0].body), { errorKey: 'dcsa.container-not-found' });
  for (const status of [403, 429, 502]) {
    const f = fixture({ status, body: 'PRIVATE' }); const x = (await runHapagBrowser(f.options)).capturedResponses[0];
    assert.equal(x.status, status); assert.equal(x.body, ''); assert.equal(x.error, null); assert.equal(x.headers['retry-after'], '60');
    assert.equal(x.headers['set-cookie'], undefined);
  }
});

test('keeps invalid JSON, a block page and an oversized body distinct', async () => {
  for (const [body, error, truncated] of [['bad', 'invalid-json', false], ['<title>Just a moment...</title>', 'challenge-html', false],
    ['x'.repeat(HAPAG_CAPTURE_BYTES + 1), null, true]]) {
    const f = fixture({ body }); const x = (await runHapagBrowser(f.options)).capturedResponses[0];
    assert.equal(x.error, error); assert.equal(x.truncated, truncated); assert.equal(x.body, null);
  }
});

test('cancels before opening and during verification, and replaces a late context', async () => {
  const f = fixture(), c = new AbortController(); c.abort();
  await assert.rejects(runHapagBrowser({ ...f.options, signal: c.signal }), { name: 'AbortError' }); assert.equal(f.state.closed, 0);
  const g = fixture({ respond: false }), d = new AbortController(); const p = runHapagBrowser({ ...g.options, signal: d.signal });
  setTimeout(() => d.abort(), 10);
  await assert.rejects(p, { name: 'AbortError' }); assert.equal(g.state.closed, 1); assert.deepEqual(g.handlers, {});
  const late = fixture({ timeout: 50 }); late.options.handle.browser.newContext = () => new Promise(r => setTimeout(() => r(late.context), 80));
  await runHapagBrowser(late.options); await new Promise(r => setTimeout(r, 80));
  assert.equal(late.state.closed, 1); assert.equal(late.state.replacement, 1);
});

test('leaves other pages to the generic tiers', async () => {
  assert.equal(await runHapagBrowser({ ...fixture().options, url: HAPAG_PAGE }), undefined);
  assert.equal(await runHapagBrowser({ ...fixture().options, capture: {} }), undefined);
});

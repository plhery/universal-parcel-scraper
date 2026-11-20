import test from 'node:test';
import assert from 'node:assert/strict';
import { boundFreightAeroLookup, freightAeroBrowserNumber, freightAeroPageUrl, projectFreightAeroReply, runFreightAeroBrowser,
  FREIGHT_AERO_LOOKUP as LOOKUP, FREIGHT_AERO_PAGE as PAGE } from './freight-aero-browser.mjs';

// A synthetic waybill and reply in the tracker's shape, with invented values.
const waybill = '997-12345675', url = freightAeroPageUrl(waybill), capture = { captureResponses: [LOOKUP] };
const reply = [{ responseCode: 'OK', awbNumber: waybill, carrier: 'BG', origin: 'DAC', destination: 'YYZ', totalPieces: 2, status: 'Departed',
  weight: '10 K', shipper: 'PRIVATE', events: {
    a: { eventSequenceNumber: 2, status: 'Departed', detail: 'Departed on flight <b>BG 0001</b>.', eventTime: '2-Jan-2026 10:00', flightNumber: 'BG0001', weight: '10 K' },
    b: { eventSequenceNumber: 1, status: 'Received from shipper', detail: 'Received.', eventTime: '1-Jan-2026 09:00', flightNumber: null } } }];
const lookup = (overrides = {}) => ({ portalId: 'CHA', awbInfo: [{ awbNumber: waybill, carrierId: 'BG' }], captchaResponse: 'PRIVATE', ...overrides });
const request = (page, data = lookup(), extra = {}) => ({ method: () => 'POST', url: () => LOOKUP, frame: () => page.mainFrame(),
  postData: () => typeof data === 'string' ? data : JSON.stringify(data), ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture({ status = 200, data = JSON.stringify(reply), headers = { 'content-type': 'application/json' }, options = ['AH-124', 'BG-997', 'KC-465'],
  prefix = '', cooldown = 0, solver = true, audioBlocked = false, delay = 0, abort = null, sends = 1, sent = () => lookup(), maxTimeout = 1000 } = {}) {
  const state = { closed: 0, contexts: 0, native: 0, checkbox: 0, selected: null, filled: {}, sent: 0, aborted: 0, blocked: 0, observerBeforeNavigation: false, opened: null };
  const frame = {}; let responseHandler, routeHandler, page;
  const send = async () => {
    for (let i = 0; i < sends; i++) {
      const req = request(page, sent()); let allowed = false;
      await routeHandler({ request: () => req, abort: async () => { state.aborted++; }, fallback: async () => { state.sent++; allowed = true; } });
      if (allowed) responseHandler?.({ request: () => req, status: () => status, headers: () => headers,
        body: async () => { if (delay) await sleep(delay); return Buffer.from(data); } });
    }
  };
  page = {
    route: async (_, fn) => { routeHandler = fn; }, mainFrame: () => frame,
    on: (event, fn) => { if (event === 'response') responseHandler = fn; }, off: () => { responseHandler = null; },
    goto: async address => { state.opened = address; state.observerBeforeNavigation = !!responseHandler; return { status: () => 200 }; },
    locator: () => ({ evaluateAll: async (fn, arg) => fn(options.map(value => ({ value })), arg) }),
    selectOption: async (_, value) => { state.selected = value; }, inputValue: async () => prefix,
    fill: async (selector, value) => { state.filled[selector] = value; }, click: async () => {},
    frameLocator: () => ({ first: () => ({ locator: () => ({ click: async () => { state.checkbox++; await send(); } }) }) }),
    waitForTimeout: ms => sleep(ms),
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { state, page, options: { url, capture, handle: { browser: { newContext: async () => { state.contexts++; return context; } } }, tier: 3, maxTimeout, signal: abort,
    audioBackoff: { remainingMs: async () => cooldown, block: () => { state.blocked++; } },
    solveNativeCaptcha: solver ? async (_page, _timeout, report) => { state.native++; if (audioBlocked) report('audio_blocked'); else await send(); } : undefined } };
}

test('takes only the tracker with a whole waybill after its hash and the lookup capture', () => {
  assert.equal(freightAeroBrowserNumber(url, capture), waybill);
  for (const u of [`${PAGE}?x=1#${waybill}`, `${PAGE}#99712345675`, `${PAGE}#997-1234567`, url.replace('https://', 'http://'), url.replace('www.', ''), `${url}x`, 'not a url'])
    assert.equal(freightAeroBrowserNumber(u, capture), null);
  for (const c of [{}, { captureResponses: [PAGE] }, { captureResponses: [LOOKUP, LOOKUP] }]) assert.equal(freightAeroBrowserNumber(url, c), null);
});

test('binds the main frame\'s POST for this waybill, the listed airline and a token', () => {
  const page = { mainFrame: () => frame }, frame = {};
  assert(boundFreightAeroLookup(request(page), waybill, 'BG', page));
  for (const r of [request(page, lookup(), { method: () => 'GET' }), request(page, lookup(), { url: () => `${LOOKUP}&x=1` }), request(page, lookup(), { frame: () => ({}) }),
    request(page, lookup({ awbInfo: [{ awbNumber: '997-12345686', carrierId: 'BG' }] })), request(page, lookup({ awbInfo: [{ awbNumber: waybill, carrierId: 'AH' }] })),
    request(page, lookup({ awbInfo: [{ awbNumber: waybill, carrierId: 'BG' }, { awbNumber: '997-12345686', carrierId: 'BG' }] })),
    request(page, lookup({ captchaResponse: '' })), request(page, lookup({ portalId: 'OTHER' })), request(page, 'not json')])
    assert(!boundFreightAeroLookup(r, waybill, 'BG', page));
  assert(!boundFreightAeroLookup(request(page), waybill, '', page));
});

test('keeps each waybill\'s route, status and events, without weights or parties', () => {
  const projected = JSON.parse(projectFreightAeroReply(reply));
  assert.deepEqual(projected, [{ responseCode: 'OK', awbNumber: waybill, carrier: 'BG', origin: 'DAC', destination: 'YYZ', totalPieces: 2, status: 'Departed', events: [
    { eventSequenceNumber: 2, status: 'Departed', detail: 'Departed on flight <b>BG 0001</b>.', eventTime: '2-Jan-2026 10:00', flightNumber: 'BG0001' },
    { eventSequenceNumber: 1, status: 'Received from shipper', detail: 'Received.', eventTime: '1-Jan-2026 09:00', flightNumber: null }] }]);
  assert.equal(projectFreightAeroReply({ error: 'Too many requests', client: 'PRIVATE' }), '{"error":"Too many requests"}');
  assert.equal(projectFreightAeroReply('text'), 'null');
  assert.deepEqual(JSON.parse(projectFreightAeroReply([{ ...reply[0], events: 'x' }, { ...reply[0], events: null }, 7])).map(row => row && row.events),
    ['unreadable', null, null]);
  const long = JSON.parse(projectFreightAeroReply([{ ...reply[0], status: 'x'.repeat(500), events: [{ detail: 'y'.repeat(2000) }] }]))[0];
  assert.equal(long.status.length, 200); assert.equal(long.events[0].detail.length, 1000);
  assert.equal(JSON.parse(projectFreightAeroReply(Array(20).fill(reply[0]))).length, 11);
});

test('picks the airline, enters the serial and captures the one bound reply', async () => {
  const f = fixture({ delay: 10, data: `\r\n\r\n${JSON.stringify(reply)}` }); const r = await runFreightAeroBrowser(f.options);
  assert(f.state.observerBeforeNavigation); assert.equal(f.state.opened, url); assert.equal(f.state.selected, 'BG-997');
  assert.deepEqual(f.state.filled, { '#prefix_1': '997', '#awb_1': '12345675' }); assert.equal(f.state.sent, 1); assert.equal(f.state.closed, 1);
  assert.equal(r.reason, 'freight-aero-reply'); assert.equal(r.capturedResponses.length, 1);
  const [row] = r.capturedResponses;
  assert.equal(row.url, LOOKUP); assert.equal(row.status, 200); assert.equal(row.trackingNumberSubmitted, '99712345675');
  assert.equal(row.body, projectFreightAeroReply(reply)); assert.equal(r.html, ''); assert.deepEqual(r.cookies, []);
  assert(!JSON.stringify(r).includes('PRIVATE'));
  const g = fixture({ prefix: '997' }); await runFreightAeroBrowser(g.options); assert.deepEqual(g.state.filled, { '#awb_1': '12345675' });
});

test('lets only one lookup for the whole waybill through', async () => {
  const f = fixture({ sends: 2 }); const r = await runFreightAeroBrowser(f.options);
  assert.equal(f.state.sent, 1); assert.equal(f.state.aborted, 1); assert.equal(r.capturedResponses.length, 1);
  const g = fixture({ sent: () => lookup({ awbInfo: [{ awbNumber: '997-12345686', carrierId: 'BG' }] }), maxTimeout: 200 }); const s = await runFreightAeroBrowser(g.options);
  assert.equal(g.state.sent, 0); assert.equal(g.state.aborted, 1); assert.equal(s.capturedResponses.length, 0); assert.equal(s.reason, 'freight-aero-capture_missing'); assert.equal(g.state.closed, 1);
});

test('asks nothing when the page does not list the airline', async () => {
  for (const options of [['AH-124'], ['BG-997', 'XX-997']]) {
    const f = fixture({ options }); const r = await runFreightAeroBrowser(f.options);
    assert.equal(r.reason, 'freight-aero-airline_missing'); assert.equal(f.state.checkbox + f.state.native + f.state.sent, 0); assert.equal(f.state.closed, 1);
  }
});

test('clicks the checkbox during the audio pause or without a solver, and reports a blocked solver', async () => {
  for (const settings of [{ cooldown: 1000 }, { solver: false }]) {
    const f = fixture(settings); const r = await runFreightAeroBrowser(f.options);
    assert.equal(f.state.checkbox, 1); assert.equal(f.state.native, 0); assert.equal(r.capturedResponses.length, 1);
  }
  const g = fixture(); await runFreightAeroBrowser(g.options); assert.equal(g.state.native, 1); assert.equal(g.state.checkbox, 0); assert.equal(g.state.blocked, 0);
  const h = fixture({ audioBlocked: true, maxTimeout: 200 }); const r = await runFreightAeroBrowser(h.options);
  assert.equal(h.state.blocked, 1); assert.equal(r.capturedResponses.length, 0); assert.equal(r.reason, 'freight-aero-capture_missing'); assert.equal(h.state.closed, 1);
});

test('keeps refusals, block pages and malformed replies apart from history', async () => {
  const run = async settings => (await runFreightAeroBrowser(fixture(settings).options)).capturedResponses[0];
  const limited = await run({ status: 429, data: '{"error":"Too many requests"}', headers: { 'content-type': 'application/json', 'retry-after': '60' } });
  assert.equal(limited.body, '{"error":"Too many requests"}'); assert.equal(limited.headers['retry-after'], '60');
  assert.deepEqual([await run({ status: 500, data: '<html><title>500 Internal Server Error</title></html>' })].map(r => [r.status, r.body, r.error]), [[500, '', null]]);
  assert.equal((await run({ data: '<html>maintenance</html>' })).error, 'invalid-json');
  assert.equal((await run({ status: 403, data: '<html><title>Just a moment...</title></html>' })).error, 'challenge-html');
  const big = await run({ headers: { 'content-length': '600000' } }); assert.equal(big.truncated, true); assert.equal(big.body, null);
});

test('leaves other pages alone, and deadline and cancellation close the context', async () => {
  const f = fixture(); assert.equal(await runFreightAeroBrowser({ ...f.options, url: `${PAGE}#997-1234567` }), undefined); assert.equal(f.state.contexts, 0);
  const g = fixture({ delay: 100, maxTimeout: 30 }); const r = await runFreightAeroBrowser(g.options);
  assert.equal(g.state.closed, g.state.contexts); assert.equal(r.capturedResponses.at(-1)?.body ?? null, null);
  const c = new AbortController(); c.abort(); const h = fixture({ abort: c.signal });
  await assert.rejects(runFreightAeroBrowser(h.options)); assert.equal(h.state.sent, 0);
});

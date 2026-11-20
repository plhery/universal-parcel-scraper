import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROHLIG_SUUS_ORIGIN, rohligSuusPageUrl, rohligSuusOrdersUrl, rohligSuusBrowserNumber, boundRohligSuusOrders,
  projectRohligSuusReply, runRohligSuusBrowser } from './rohlig-suus-browser.mjs';

const number = 'ZZZZ000000001', url = rohligSuusPageUrl(number), orders = rohligSuusOrdersUrl(number);
const capture = { captureResponses: [orders] }, frame = {};
const payload = { id: 1, parcelNumber: number, referenceNumber: 'PRIVATE', statusId: 39, stageId: 6, location: 'KTW', principalId: 'PRIVATE',
  deliveryDate: '2026-01-21T00:00:00', collectDate: '2026-01-20T00:00:00', transportType: 'road', isAnomaly: false,
  origins: [{ city: 'PRIVATE', postalCode: 'PRIVATE', country: 'PL' }],
  destinations: [{ city: 'PRIVATE', postalCode: 'PRIVATE', country: 'PL', recipientName: 'PRIVATE', deliveryAddressName: 'PRIVATE' }],
  events: [
    { statusId: 327, created: '2026-01-20T08:00:00', location: 'KTW', speedCode: 'EML01', eventNote: '21.01.2026' },
    { statusId: 180, created: '2026-01-20T08:00:00', location: 'KTW', speedCode: 'ODB_I', eventNote: 'PRIVATE' },
    { statusId: 39, created: '2026-01-21T12:36:58', location: 'PIE', speedCode: 'UNLO', eventNote: null },
  ], trackingInstructions: [{ id: 1, speedCode: 'PRIVATE' }], attachedDocuments: ['PRIVATE'] };
const lookup = (extra = {}) => ({ method: () => 'GET', url: () => orders, frame: () => frame, ...extra });

function fixture({ body = JSON.stringify(payload), status = 200, timeout = 1000, respond: answer = true } = {}) {
  const handlers = {}, state = { closed: 0, policy: 0, aborted: 0, fallback: 0 };
  let route;
  const respond = (request, s, headers, text = '') => handlers.response?.({ request: () => request, status: () => s, headers: () => headers,
    body: async () => Buffer.from(text) });
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    route: async (re, f) => { assert.ok(re.test(orders)); assert.ok(re.test(`${ROHLIG_SUUS_ORIGIN}/api/parcel/guest/tracking/orders/contact-matrix-box`));
      assert.equal(re.test(`${ROHLIG_SUUS_ORIGIN}/api/parcel/tracking/dictionaries/locations?locale=en`), false); route = f; },
    goto: async () => {
      if (answer) setTimeout(async () => {
        const other = lookup({ url: () => rohligSuusOrdersUrl('ZZZZ000000002') });
        await route({ request: () => other, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
        const get = lookup();
        await route({ request: () => get, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
        respond(other, 200, { 'content-type': 'application/json' }, '{"parcelNumber":"ZZZZ000000002"}');
        respond(get, status, { 'content-type': 'application/json', 'set-cookie': 'PRIVATE' }, body);
      }, 2);
      return { status: () => 200 };
    },
    url: () => url, bringToFront: async () => {},
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => {} };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, handlers };
}

test('takes only the order page for one whole number with its own lookup capture', () => {
  assert.equal(rohligSuusBrowserNumber(url, capture), number);
  for (const u of [url.replace('https:', 'http:'), url + '?x=1', url + '/', url.replace('portal.suus.com', 'example.test'),
    `${ROHLIG_SUUS_ORIGIN}/visibility`, rohligSuusPageUrl('zzzz000000001'), rohligSuusPageUrl('ZZZZ%20000000001')]) {
    assert.equal(rohligSuusBrowserNumber(u, { captureResponses: [orders] }), null, u);
  }
  assert.equal(rohligSuusBrowserNumber(url, { captureResponses: [rohligSuusOrdersUrl('ZZZZ000000002')] }), null);
  assert.equal(rohligSuusBrowserNumber(url, { captureResponses: [orders, orders] }), null);
});

test('binds the lookup to the whole number', () => {
  const page = { mainFrame: () => frame };
  assert.equal(boundRohligSuusOrders(lookup(), number, page), true);
  assert.equal(boundRohligSuusOrders(lookup({ url: () => `${ROHLIG_SUUS_ORIGIN}/api/parcel/guest/tracking/orders?parcelNumber=${number}&locale=pl` }), number, page), true);
  for (const r of [lookup({ method: () => 'POST' }), lookup({ url: () => rohligSuusOrdersUrl(`${number}0`) }),
    lookup({ url: () => `${orders}&parcelNumber=${number}` }), lookup({ url: () => orders.replace('/orders?', '/orders/contact-matrix-box?') }),
    lookup({ url: () => orders.replace('portal.suus.com', 'example.test') }), lookup({ frame: () => ({}) })]) {
    assert.equal(boundRohligSuusOrders(r, number, page), false);
  }
});

test('passes on tracking fields only', () => {
  const x = JSON.parse(projectRohligSuusReply(payload));
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.deepEqual(x.destinations, [{ country: 'PL' }]);
  assert.deepEqual(x.events.map(e => e.eventNote), ['21.01.2026', null, null]);
  assert.deepEqual(x.events[2], { statusId: 39, created: '2026-01-21T12:36:58', location: 'PIE', speedCode: 'UNLO', eventNote: null });
  for (const x of [null, [], 'x']) assert.equal(projectRohligSuusReply(x), 'null');
  assert.equal(JSON.parse(projectRohligSuusReply({ parcelNumber: number, events: {} })).events, null);
});

test('captures the page’s own lookup and stops other numbers', async () => {
  const f = fixture(); const r = await runRohligSuusBrowser(f.options);
  assert.equal(r.reason, 'rohlig-suus-reply'); assert.equal(f.state.aborted, 1); assert.equal(f.state.fallback, 1);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(r.capturedResponses[0].url, orders);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.state.policy, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('keeps the empty answers for an unknown number and a refused token', async () => {
  for (const status of [204, 500]) {
    const r = await runRohligSuusBrowser(fixture({ status, body: '' }).options);
    assert.equal(r.reason, 'rohlig-suus-reply'); assert.equal(r.capturedResponses[0].status, status); assert.equal(r.capturedResponses[0].body, '');
  }
});

test('reports a lookup that never came', async () => {
  const f = fixture({ respond: false, timeout: 300 }); const r = await runRohligSuusBrowser(f.options);
  assert.equal(r.reason, 'rohlig-suus-capture_missing'); assert.equal(r.capturedResponses.length, 0); assert.equal(f.state.closed, 1);
});

test('leaves other pages to the generic tiers', async () => {
  assert.equal(await runRohligSuusBrowser({ ...fixture().options, url: `${ROHLIG_SUUS_ORIGIN}/visibility` }), undefined);
});

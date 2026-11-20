import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONEX_ORIGIN, onexPageUrl, onexLookupUrl, onexBrowserNumber, boundOnexLookup, projectOnexReply, runOnexBrowser } from './onex-browser.mjs';

const number = 'ZZZZ000000001', url = onexPageUrl(number), lookupUrl = onexLookupUrl();
const capture = { captureResponses: [lookupUrl] }, frame = {};
const payload = { status: 1, msg: 'ok', data: {
  import: { orderstatus: 'in Armenia', parcelid: 99, idbox: 'PRIVATE', weight: 'PRIVATE', wo_scanneddate: '2026-01-10 08:00:00',
    inusadate: '2026-01-10 09:00:00', inmywaydate: '2026-01-12 10:00:00', inarmeniadate: '2026-01-18 11:00:00', receiveddate: null,
    estdate: '2026-01-19 00:00:00', country: 'usa', dispatch: '0', recipient: { name: 'PRIVATE' } },
  export: false, track: { checkpoints: [{ message: 'PRIVATE' }], courier: { slug: 'usps' } },
  iherb: [{ event_description: 'Out for Delivery', date: '2026-01-19 10:00:00', logo: 'PRIVATE', location: 'Yerevan',
    pickup_point: { long_name: 'Onex Komitas', phone: 'PRIVATE' } }],
  pdd_external_info: { cost: 'PRIVATE', tax_message: 'PRIVATE' }, warning_message: 'PRIVATE' } };
const post = (body = `tcode=${number}`, extra = {}) => ({ method: () => 'POST', url: () => lookupUrl, postData: () => body, frame: () => frame, ...extra });

function fixture({ body = JSON.stringify(payload), status = 200, timeout = 1000, respond: answer = true, pageStatus = 200 } = {}) {
  const handlers = {}, state = { closed: 0, policy: 0, aborted: 0, fallback: 0 };
  let route;
  const respond = (request, s, headers, text = '') => handlers.response?.({ request: () => request, status: () => s, headers: () => headers,
    body: async () => Buffer.from(text) });
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    route: async (re, f) => { assert.ok(re.test(lookupUrl)); assert.ok(re.test(`${ONEX_ORIGIN}/onextrack/findtrackingcodeimport`));
      assert.equal(re.test(`${ONEX_ORIGIN}/parcel/hub`), false); route = f; },
    goto: async () => {
      if (answer) setTimeout(async () => {
        const other = post('tcode=ZZZZ000000002');
        await route({ request: () => other, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
        const mine = post();
        await route({ request: () => mine, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
        respond(other, 200, { 'content-type': 'text/html' }, '{"status":1,"data":{"iherb":[]}}');
        respond(mine, status, { 'content-type': 'text/html; charset=UTF-8', 'set-cookie': 'PRIVATE' }, body);
      }, 2);
      return { status: () => pageStatus };
    },
    url: () => url, bringToFront: async () => {},
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => {} };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, handlers };
}

test('takes only the English tracker for one whole number with its own lookup capture', () => {
  assert.equal(url, `${ONEX_ORIGIN}/en/onextrack?track=${number}`);
  assert.equal(onexBrowserNumber(url, capture), number);
  for (const u of [url.replace('https:', 'http:'), `${url}&x=1`, `${url}&track=${number}`, url.replace('onex.am', 'example.test'),
    `${ONEX_ORIGIN}/onextrack?track=${number}`, `${ONEX_ORIGIN}/en/onextrack`, onexPageUrl('zzzz000000001'), onexPageUrl('ZZZZ 000000001')]) {
    assert.equal(onexBrowserNumber(u, capture), null, u);
  }
  assert.equal(onexBrowserNumber(url, { captureResponses: [`${ONEX_ORIGIN}/onextrack/findtrackingcodeimport`] }), null);
  assert.equal(onexBrowserNumber(url, { captureResponses: [lookupUrl, lookupUrl] }), null);
});

test('binds the lookup to the whole number', () => {
  const page = { mainFrame: () => frame };
  assert.equal(boundOnexLookup(post(), number, page), true);
  for (const r of [post(undefined, { method: () => 'GET' }), post(`tcode=${number}0`), post(`tcode=${number}&tcode=${number}`),
    post(`tcode=${number}&x=1`), post(''), post(undefined, { postData: () => null }),
    post(undefined, { url: () => `${ONEX_ORIGIN}/onextrack/findtrackingcodeimport` }), post(undefined, { url: () => `${lookupUrl}?x=1` }),
    post(undefined, { frame: () => ({}) })]) {
    assert.equal(boundOnexLookup(r, number, page), false);
  }
});

test('passes on tracking fields only', () => {
  const x = JSON.parse(projectOnexReply(payload));
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.equal(x.data.track, true);
  assert.deepEqual(x.data.iherb, [{ event_description: 'Out for Delivery', date: '2026-01-19 10:00:00', location: 'Yerevan', pickup_point: { long_name: 'Onex Komitas' } }]);
  assert.deepEqual(Object.keys(x.data.import), ['orderstatus', 'estdate', 'wo_scanneddate', 'inusadate', 'inmywaydate', 'inarmeniadate', 'receiveddate']);
  assert.equal(x.data.export, false);
  const unknown = JSON.parse(projectOnexReply({ status: 1, msg: 'ok', data: { import: false, export: false, track: null, iherb: false } }));
  assert.deepEqual(unknown, { status: 1, data: { import: false, export: false, track: null, iherb: false } });
  assert.deepEqual(JSON.parse(projectOnexReply({ status: 1, data: { import: [], export: 'x', iherb: {} } })).data,
    { import: 'unreadable', export: 'unreadable', track: true, iherb: 'unreadable' });
  for (const x of [null, [], 'x']) assert.equal(projectOnexReply(x), 'null');
  assert.deepEqual(JSON.parse(projectOnexReply({ status: 0 })), { status: 0, data: null });
});

test('captures the page’s own lookup and stops other numbers', async () => {
  const f = fixture(); const r = await runOnexBrowser(f.options);
  assert.equal(r.reason, 'onex-reply'); assert.equal(f.state.aborted, 1); assert.equal(f.state.fallback, 1);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(r.capturedResponses[0].url, lookupUrl);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.state.policy, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('waits through a challenge page for the lookup that follows it', async () => {
  const r = await runOnexBrowser(fixture({ pageStatus: 403 }).options);
  assert.equal(r.reason, 'onex-reply'); assert.equal(r.statusCode, 403); assert.equal(r.capturedResponses.length, 1);
});

test('keeps a refused lookup and a challenge in its place', async () => {
  const refused = await runOnexBrowser(fixture({ status: 403, body: '<title>Just a moment...</title>' }).options);
  assert.equal(refused.capturedResponses[0].status, 403); assert.equal(refused.capturedResponses[0].body, '');
  const page = await runOnexBrowser(fixture({ body: '<html><title>Just a moment...</title></html>' }).options);
  assert.equal(page.capturedResponses[0].error, 'challenge-html');
});

test('reports a lookup that never came', async () => {
  const f = fixture({ respond: false, timeout: 300, pageStatus: 403 }); const r = await runOnexBrowser(f.options);
  assert.equal(r.reason, 'onex-capture_missing'); assert.equal(r.statusCode, 403); assert.equal(r.capturedResponses.length, 0);
  assert.equal(f.state.closed, 1);
});

test('leaves other pages to the generic tiers', async () => {
  assert.equal(await runOnexBrowser({ ...fixture().options, url: `${ONEX_ORIGIN}/en/onextrack` }), undefined);
});

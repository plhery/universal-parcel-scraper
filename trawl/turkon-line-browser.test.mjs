import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TURKON_ORIGIN, TURKON_PAGE, turkonPageUrl, turkonLowerUrl, turkonBrowserNumber, boundTurkonLookup, projectTurkonReply,
  runTurkonBrowser } from './turkon-line-browser.mjs';

const number = '99999901', url = turkonPageUrl(number), lowerUrl = turkonLowerUrl(number);
const capture = { captureResponses: [lowerUrl] }, frame = {};
const GUEST = '{"token":null,"cookie":null}';
const service = (part, lang = 'tr', n = number) => `${TURKON_ORIGIN}/shipping-prod-service/tracking/getTracking${part}Information/${lang}/${n}`;
const payload = { friendlyMessage: { title: 'PRIVATE' }, hasError: false, errorMessages: null, httpStatus: 'OK', payload: [{
  bookingNo: '00000000000099999901', containerNo: 'ZZZU0000001', containerType: 'PRIVATE', cargoWeight: 'PRIVATE', vgmVal: 'PRIVATE',
  polGemi: 'PRIVATE', polSefer: 'PRIVATE', returnDescr40: 'PRIVATE', pol: 'Sample Port', pod: 'Other Port', podEstDate: '02.01.2026',
  lastEvent: 'LDF', lastEventName: 'FULL LOAD',
  getKonteynerTakipEventSet: { results: [
    { containerNo: 'ZZZU0000001', gemi: 'PRIVATE', cvnNum: 'PRIVATE', ekVeri2: 'PRIVATE', eventSira: '10', eventCode: 'LDF',
      eventName: 'FULL LOAD', eventTarih: '01.01.2026', eventSaat: '10:00:00', eventLokasyon: 'Sample Port', ekVeri3: '2' },
  ] } }] };
const post = (address, extra = {}) => ({ method: () => 'POST', url: () => address, postData: () => GUEST, frame: () => frame,
  isNavigationRequest: () => false, ...extra });
const navigation = { method: () => 'GET', url: () => TURKON_PAGE, frame: () => frame, isNavigationRequest: () => true };

function fixture({ body = JSON.stringify(payload), status = 200, timeout = 1000, answer = true, challenged = false, box = true, lang = 'tr' } = {}) {
  const handlers = {}, state = { closed: 0, policy: 0, aborted: [], fallback: [], typed: [] };
  let route;
  const respond = (request, s, headers, text = '', address = request.url()) => handlers.response?.({ request: () => request, status: () => s,
    headers: () => headers, url: () => address, body: async () => Buffer.from(text) });
  const send = async request => route({ request: () => request, fallback: async () => { state.fallback.push(request.url()); },
    abort: async () => { state.aborted.push(request.url()); } });
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    route: async (re, f) => { assert.ok(re.test(lowerUrl)); assert.ok(re.test(service('Top')));
      assert.equal(re.test(`${TURKON_ORIGIN}/assets/i18n/tr.json`), false); route = f; },
    goto: async target => {
      assert.equal(target, TURKON_PAGE);
      respond(navigation, challenged ? 403 : 200, {});
      if (challenged && box) setTimeout(() => respond(navigation, 200, {}), 1);
      return { status: () => challenged ? 403 : 200 };
    },
    locator: selector => ({ first: () => ({
      waitFor: async ({ timeout }) => { assert.equal(selector, 'input[pinputtext]');
        if (!box) await new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), Math.min(timeout, 50))); },
      fill: async value => { state.typed.push(value); },
      press: async key => {
        assert.equal(key, 'Enter');
        if (!answer) return;
        setTimeout(async () => {
          const other = post(service('Lower', lang, '99999902')), top = post(service('Top', lang)), mine = post(service('Lower', lang));
          for (const request of [other, top, mine]) await send(request);
          respond(other, 200, { 'content-type': 'application/json' }, '{"payload":[]}');
          respond(top, 200, { 'content-type': 'application/json' }, '{"payload":[{"eventCode":"BK"}]}');
          respond(mine, status, { 'content-type': 'application/json;charset=UTF-8', 'set-cookie': 'PRIVATE' }, body);
        }, 2);
      },
    }) }),
    url: () => TURKON_PAGE, bringToFront: async () => {},
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => {} };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, handlers };
}

test('takes only the tracking page for one whole number with its containers’ capture', () => {
  assert.equal(url, `${TURKON_ORIGIN}/tracking?tracking=${number}`);
  assert.equal(lowerUrl, `${TURKON_ORIGIN}/shipping-prod-service/tracking/getTrackingLowerInformation/en/${number}`);
  assert.equal(turkonBrowserNumber(url, capture), number);
  for (const u of [url.replace('https:', 'http:'), `${url}&x=1`, `${url}&tracking=${number}`, url.replace('myturkonline.turkon.com', 'example.test'),
    TURKON_PAGE, turkonPageUrl('zz99999901'), turkonPageUrl('99999 901'), turkonPageUrl('99999')]) {
    assert.equal(turkonBrowserNumber(u, capture), null, u);
  }
  assert.equal(turkonBrowserNumber(url, { captureResponses: [turkonLowerUrl('99999902')] }), null);
  assert.equal(turkonBrowserNumber(url, { captureResponses: [lowerUrl, lowerUrl] }), null);
  assert.equal(turkonBrowserNumber(url, { captureResponses: [service('Top', 'en')] }), null);
});

test('binds both lookups to the whole number, as a guest, in either language', () => {
  const page = { mainFrame: () => frame };
  assert.equal(boundTurkonLookup(post(service('Top')), number, page), 'top');
  assert.equal(boundTurkonLookup(post(service('Lower', 'en')), number, page), 'lower');
  for (const r of [post(service('Lower'), { method: () => 'GET' }), post(service('Lower', 'tr', `${number}0`)), post(service('Lower', 'tr', 'ZZ')),
    post(service('Lower', 'de')), post(`${service('Lower')}?x=1`), post(`${service('Lower')}/x`), post(service('Lower').replace('Lower', 'Other')),
    post(service('Lower'), { postData: () => '{"token":"PRIVATE","cookie":null}' }), post(service('Lower'), { postData: () => null }),
    post(service('Lower').replace(TURKON_ORIGIN, 'https://example.test')), post(service('Lower'), { frame: () => ({}) })]) {
    assert.equal(boundTurkonLookup(r, number, page), null, r.url());
  }
});

test('passes on moves and places only', () => {
  const x = JSON.parse(projectTurkonReply(payload));
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.deepEqual(x, { hasError: false, httpStatus: 'OK', errorMessages: null, payload: [{
    bookingNo: '00000000000099999901', containerNo: 'ZZZU0000001', pol: 'Sample Port', pod: 'Other Port', podEstDate: '02.01.2026',
    lastEvent: 'LDF', lastEventName: 'FULL LOAD', events: [{ containerNo: 'ZZZU0000001', eventCode: 'LDF', eventName: 'FULL LOAD',
      eventTarih: '01.01.2026', eventSaat: '10:00:00', eventLokasyon: 'Sample Port', ekVeri3: '2' }] }] });
  assert.deepEqual(JSON.parse(projectTurkonReply({ hasError: true, errorMessages: ['PRIVATE'], payload: null })),
    { hasError: true, errorMessages: 1, payload: 'unreadable' });
  assert.deepEqual(JSON.parse(projectTurkonReply({ payload: [null, { bookingNo: '1', getKonteynerTakipEventSet: {} }] })).payload,
    [null, { bookingNo: '1', events: 'unreadable' }]);
  for (const x of [null, [], 'x']) assert.equal(projectTurkonReply(x), 'null');
});

test('types the number into the page and captures its containers’ lookup', async () => {
  const f = fixture(); const r = await runTurkonBrowser(f.options);
  assert.equal(r.reason, 'turkon-line-reply'); assert.equal(r.statusCode, 200); assert.deepEqual(f.state.typed, [number]);
  assert.deepEqual(f.state.aborted, [service('Lower', 'tr', '99999902')]);
  assert.deepEqual(f.state.fallback, [service('Top'), service('Lower')]);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(r.capturedResponses[0].url, lowerUrl); assert.equal(r.effectiveUrl, url);
  assert.equal(JSON.parse(r.capturedResponses[0].body).payload[0].events.length, 1);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.state.policy, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('waits through Cloudflare’s check for the page it reloads', async () => {
  const r = await runTurkonBrowser(fixture({ challenged: true, lang: 'en' }).options);
  assert.equal(r.reason, 'turkon-line-reply'); assert.equal(r.statusCode, 200); assert.equal(r.capturedResponses.length, 1);
});

test('keeps a refused lookup and a challenge in its place', async () => {
  const refused = await runTurkonBrowser(fixture({ status: 403, body: '<title>Just a moment...</title>' }).options);
  assert.equal(refused.capturedResponses[0].status, 403); assert.equal(refused.capturedResponses[0].body, '');
  const page = await runTurkonBrowser(fixture({ body: '<html><title>Just a moment...</title></html>' }).options);
  assert.equal(page.capturedResponses[0].error, 'challenge-html');
  const broken = await runTurkonBrowser(fixture({ body: '{' }).options);
  assert.equal(broken.capturedResponses[0].error, 'invalid-json');
});

test('reports a check that never let the page load', async () => {
  const f = fixture({ challenged: true, box: false, answer: false, timeout: 300 }); const r = await runTurkonBrowser(f.options);
  assert.equal(r.reason, 'turkon-line-capture_missing'); assert.equal(r.statusCode, 403); assert.equal(r.capturedResponses.length, 0); assert.equal(f.state.closed, 1);
  assert.deepEqual(f.state.typed, []);
});

test('leaves other pages to the generic tiers', async () => {
  assert.equal(await runTurkonBrowser({ ...fixture().options, url: TURKON_PAGE }), undefined);
});

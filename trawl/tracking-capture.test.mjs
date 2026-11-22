import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { attachTrackingCapture, australiaPostClientKnown, requestAustraliaPostInPage, requestAustraliaPostMainWorld, reserveDeadline, unreadByLookup, untilPageReady } from './tracking-capture.mjs';
import { swiftxDropPhoneFragment, swiftxEnterPhoneDigits } from './swiftx-slider.mjs';
const api = 'https://t.17track.net/track/restapi';
const number = 'ZZ12345678900';
const reply = code => JSON.stringify({ meta: { code: 200 }, shipments: [{ number, code }] });
const upsApi = 'https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US';
// A made-up number in UPS's published format, the same one the adapter's tests use.
const upsNumber = '1Z999AA10123456784';
const upsUrl = `https://www.ups.com/track?loc=en_US&tracknum=${upsNumber}&requester=ST%2Ftrackdetails`;
const upsReply = (trackingNumber = upsNumber, statusCode = '200') => JSON.stringify({ statusCode, trackDetails: [{ trackingNumber }] });
const fedexApi = 'https://api.fedex.com/track/v2/shipments';
// A made-up number in FedEx's published format, the same one the adapter's tests use.
const fedexNumber = '999999999999';
const fedexUrl = `https://www.fedex.com/wtrk/track/?trknbr=${fedexNumber}`;
const fedexReply = (trackingNbr = fedexNumber) => JSON.stringify({ output: { packages: [{ trackingNbr }] } });
async function fixture(url = `https://t.17track.net/en#nums=${number}`, endpoint = api, additional = [], extra = {}) {
  const handlers = {};
  const listeners = new Map();
  let detached = false;
  const detachedEvents = [];
  const routes = [];
  const page = { addInitScript: async () => {}, route: async (pattern, handler) => { routes.push([pattern, handler]); },
    context: () => ({addCookies: async () => {}}), on: (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    handlers[event] = value => Promise.all([...listeners.get(event)].map(listener => listener(value)));
  }, off: (event, fn) => { listeners.get(event)?.delete(fn); detached = true; detachedEvents.push(event); }, ...extra };
  const capture = await attachTrackingCapture(page, url, { captureResponses: [endpoint, ...additional] });
  const respond = (body, { url = endpoint, headers = {}, status = 200, method = endpoint === api || endpoint === upsApi ? 'POST' : 'GET', read,
    requestBody = endpoint === api ? { data: [{ num: number }] } : endpoint === upsApi ? { TrackingNumber: [upsNumber.toLowerCase()] } : undefined } = {}) => handlers.response({
    url: () => url, status: () => status, request: () => ({url: () => url, method: () => method, postDataJSON: () => requestBody}),
    headers: () => ({ 'content-type': 'application/json', 'content-length': String(body.length), 'content-encoding': 'gzip', ...headers }),
    body: read ?? (async () => Buffer.from(body)),
  });
  return { page, capture, respond, handlers, routes, detachedEvents, detached: () => detached };
}

const yunApi = 'https://services.yuntrack.com/Track/Query';
const expressApi = 'https://mydhl.express.dhl/shipmentTracking';
const expressNumber = '1234567891';
const expressUrl = `https://mydhl.express.dhl/gb/en/tracking.html#/results?id=${expressNumber}`;
const expressRequest = `${expressApi}?${new URLSearchParams({ AWB: expressNumber, clientApp: 'mydhlplus', countryCode: 'gb', languageCode: 'en',
  requestAdditionalDetails: 'controlledAccessDataCodes,productCode,shipmentActivationDate,countryCodes' }).toString().replace(/%2C/g, ',')}`;

test('DHL Express captures only its own page and exact waybill request, including decoded compressed data', async () => {
  for (const url of [expressUrl.replace('mydhl.express.dhl', 'other.test'), expressUrl.replace('/gb/en/', '/gb/fr/'),
    expressUrl + '&id=0000000000', expressUrl + '&other=1']) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [expressApi] }), undefined);
  }
  const { capture, respond } = await fixture(expressUrl, expressApi);
  assert.equal(capture.solverSignal, undefined);
  await respond(JSON.stringify({ results: [{ id: expressNumber }] }), { url: expressRequest.replace(expressNumber, '0000000000') });
  assert.equal(capture.hasResponse(), false);
  await respond(JSON.stringify({ results: [{ id: expressNumber, checkpoints: [] }] }), { url: expressRequest });
  await capture.settle(100);
  assert.equal(capture.hasResponse(), true);
  const data = await capture.drain();
  assert.equal(data.capturedResponses.length, 1);
  assert.equal(JSON.parse(data.capturedResponses[0].body).results[0].id, expressNumber);
});

test('DHL Express retains an explicit not-found reply', async () => {
  const { capture, respond } = await fixture(expressUrl, expressApi);
  await respond(JSON.stringify({ errors: [{ id: expressNumber, code: 404 }] }), { url: expressRequest });
  await capture.settle(100);
  assert.equal(JSON.parse((await capture.drain()).capturedResponses[0].body).errors[0].code, 404);
});
const yunNumber = 'YT0000000000000001';
const yunUrl = `https://www.yuntrack.com/parcelTracking?id=${yunNumber}`;
const yunRequest = (values = [yunNumber]) => ({ NumberList: values });
const yunReply = (id = yunNumber) => JSON.stringify({ ResultList: [{ Id: id, TrackInfo: { WaybillNumber: id } }] });

test('YunExpress capture is restricted to the exact public page and one valid parcel', async () => {
  for (const url of [yunUrl.replace('www.yuntrack.com', 'other.test'), yunUrl.replace('/parcelTracking', '/other'),
    yunUrl + '&id=' + yunNumber, yunUrl + '&other=1', yunUrl + '#test', yunUrl.replace(yunNumber, 'YT000000000000000'),
    yunUrl.replace(yunNumber, yunNumber + ',YT0000000000000002')]) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [yunApi] }), undefined);
  }
  assert.equal(await attachTrackingCapture({}, yunUrl, { captureResponses: [yunApi + '?other=1'] }), undefined);
});

test('YunExpress captures only the browser POST for exactly the requested NumberList', async () => {
  const { capture, respond, handlers } = await fixture(yunUrl, yunApi);
  for (const [method, requestBody] of [['GET', yunRequest()], ['OPTIONS', yunRequest()], ['POST', null],
    ['POST', yunRequest(['YT0000000000000002'])], ['POST', yunRequest([yunNumber, 'YT0000000000000002'])]]) {
    await respond(yunReply(), { method, requestBody });
  }
  assert.equal(capture.hasResponse(), false);
  assert.equal(capture.hasTrackingRequest(), false);
  const request = { url: () => yunApi, method: () => 'POST', postDataJSON: () => yunRequest() };
  handlers.request(request);
  assert.equal(capture.hasTrackingRequest(), true);
  await respond(yunReply(), { method: 'POST', requestBody: yunRequest(), headers: { 'set-cookie': 'PRIVATE_COOKIE' } });
  assert.equal(capture.hasResponse(), true);
  await capture.settle(100);
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, yunReply());
  assert.deepEqual(rows[0].headers, {});
});

test('YunExpress keeps returned identity failures for the adapter rather than waiting for an older success', async () => {
  const { capture, respond } = await fixture(yunUrl, yunApi);
  const body = yunReply('YT0000000000000002');
  await respond(body, { method: 'POST', requestBody: yunRequest() });
  assert.equal(capture.hasResponse(), true);
  await capture.settle(100);
  assert.equal((await capture.drain()).capturedResponses[0].body, body);
});

test('YunExpress ends on explicit negative and interactive-verification envelopes', async () => {
  const negative = JSON.stringify({ ResultList: [{ Id: yunNumber, Status: 0, TrackInfo: { WaybillNumber: yunNumber,
    TrackingStatus: 0, TrackEventCount: 0, TrackEventDetails: [], LastTrackEvent: { TrackingStatus: 0,
      ProcessDate: '', ProcessContent: '', ProcessLocation: '' } }, TrackData: { ChildCount: 0, ProcessGroupList: [] } }] });
  for (const body of [negative, JSON.stringify({ Code: 1003 }), JSON.stringify({ Code: 1004 }), '{}']) {
    const { capture, respond } = await fixture(yunUrl, yunApi);
    await respond(body, { method: 'POST', requestBody: yunRequest() });
    assert.equal(capture.hasResponse(), true);
    await capture.settle(100);
    assert.equal((await capture.drain()).capturedResponses[0].body, body);
  }
});

test('YunExpress finishes decoded invalid JSON roots without waiting for another reply', async () => {
  for (const body of ['null', '[]', '17', 'true', '"invalid root"']) {
    const { capture, respond } = await fixture(yunUrl, yunApi);
    await respond(body, { method: 'POST', requestBody: yunRequest() });
    assert.equal(capture.hasResponse(), true);
    await capture.settle(100);
    assert.equal((await capture.drain()).capturedResponses[0].body, body);
  }
});

test('YunExpress preserves HTTP challenges and rate limits without reading their bodies', async () => {
  for (const status of [401, 403, 405, 429]) {
    const { capture, respond } = await fixture(yunUrl, yunApi);
    await respond('', { method: 'POST', requestBody: yunRequest(), status, headers: { 'retry-after': '300' },
      read: () => { throw new Error('must not read rejected body'); } });
    assert.equal(capture.hasResponse(), true);
    const row = (await capture.drain()).capturedResponses[0];
    assert.equal(row.status, status);
    assert.equal(row.body, null);
    assert.equal(row.headers['retry-after'], '300');
  }
});

test('YunExpress rejects malformed or excessive decoded bodies as incomplete capture', async () => {
  for (const [body, headers] of [['invalid JSON', {}], [yunReply(), { 'content-length': '2000001' }]]) {
    const { capture, respond } = await fixture(yunUrl, yunApi);
    await respond(body, { method: 'POST', requestBody: yunRequest(), headers });
    assert.equal(capture.hasResponse(), true);
    assert.ok((await capture.drain()).capturedResponses[0].error);
  }
});

test('YunExpress ends failed requests promptly and sanitizes their diagnostics', async () => {
  const { capture, handlers, detachedEvents } = await fixture(yunUrl, yunApi);
  const request = { url: () => yunApi, method: () => 'POST', postDataJSON: () => yunRequest(),
    failure: () => ({ errorText: 'PRIVATE_TOKEN in unexpected network text' }) };
  handlers.request(request);
  handlers.requestfailed(request);
  await capture.settle(100);
  await assert.rejects(capture.drain(), { message: 'YunExpress tracking request failed: network failure' });
  assert.deepEqual(detachedEvents, ['response', 'request', 'requestfailed']);
});

test('YunExpress cleanup detaches all observers and ignores late response bodies', async () => {
  const { capture, respond, detachedEvents } = await fixture(yunUrl, yunApi);
  let release;
  const reading = respond(yunReply(), { method: 'POST', requestBody: yunRequest(), read: () => new Promise(resolve => { release = resolve; }) });
  await capture.settle(1);
  const snapshot = await capture.drain();
  release(Buffer.from(yunReply()));
  await reading;
  await respond(yunReply(), { method: 'POST', requestBody: yunRequest() });
  assert.equal(snapshot.capturedResponses.length, 1);
  assert.equal(snapshot.capturedResponses[0].body, null);
  assert.deepEqual(detachedEvents, ['response', 'request', 'requestfailed']);
});

for (const missing of [false, true]) test(`YunExpress live hook reads a fresh ${missing ? 'missing-item' : 'known-parcel'} response`, {
  skip: !process.env.TRACKING_CHROMIUM_PATH || !process.env.YUNEXPRESS_TRACKING_NUMBER, timeout: 30_000,
}, async () => {
  const { chromium } = await import('playwright-core');
  const requested = missing ? 'YT0000000000000000' : process.env.YUNEXPRESS_TRACKING_NUMBER;
  assert.ok(/^YT\d{16}$/.test(requested));
  const browser = await chromium.launch({ executablePath: process.env.TRACKING_CHROMIUM_PATH, headless: true, timeout: 10_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', LANG: 'en_US.UTF-8' } });
  let capture;
  try {
    const page = await browser.newPage({ locale: 'en-US' });
    const url = `https://www.yuntrack.com/parcelTracking?id=${requested}`;
    capture = await attachTrackingCapture(page, url, { captureResponses: [yunApi], settleTimeout: 15_000 });
    const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    assert.equal(navigation.status(), 200);
    await capture.settle(15_000);
    const rows = (await capture.drain()).capturedResponses;
    capture = undefined;
    assert.ok(rows.length > 0);
    const response = rows.at(-1);
    assert.equal(response.status, 200);
    assert.equal(response.error, undefined);
    assert.equal(response.truncated, false);
    const payload = JSON.parse(response.body);
    assert.equal(payload.ResultList.length, 1);
    const item = payload.ResultList[0];
    assert.ok(item.Id === requested && item.TrackInfo.WaybillNumber === requested);
    const scans = item.TrackData.ProcessGroupList.flatMap(group => group.ProcessDetailList);
    if (missing) {
      assert.equal(item.Status, 0);
      assert.equal(item.TrackInfo.TrackingStatus, 0);
      assert.equal(item.TrackInfo.TrackEventCount, 0);
      assert.equal(scans.length, 0);
      assert.deepEqual(item.TrackInfo.TrackEventDetails, []);
    } else {
      assert.ok(scans.length > 0);
      assert.equal(scans.length, item.TrackInfo.TrackEventDetails.length);
    }
  } finally {
    await capture?.drain().catch(() => {});
    await browser.close();
  }
});

const swiftxApi = 'https://swiftx-express.com/api/graphql';
const swiftxNumber = 'SWX000000000000000001';
const swiftxUrl = `https://swiftx-express.com/track?trackingNumber=${swiftxNumber}`;
const swiftxQuery = '\n query GetOfficialWebsiteTrackingInfoBatch($input: OfficialWebsiteBatchTrackingInput!) {\n getOfficialWebsiteTrackingInfoBatch(input: $input) { success results { success trackingNo } } }';
const swiftxRequest = (input = { trackingNos: [swiftxNumber], humanToken: 'SYNTHETIC_TOKEN' }, query = swiftxQuery) => ({ query, variables: { input } });
const swiftxReply = (success = true) => JSON.stringify({ data: { getOfficialWebsiteTrackingInfoBatch: { success: true, message: '', errorCode: null,
  results: [{ success, message: success ? '' : 'Order not found.', errorCode: null, trackingNo: swiftxNumber, trackingEventList: [] }] } } });

test('SwiftX capture is restricted to the tracking page and one whole SWX number', async () => {
  for (const url of [swiftxUrl.replace('swiftx-express.com', 'other.test'), swiftxUrl.replace('://', '://www.'),
    swiftxUrl.replace('/track', '/es/track'), swiftxUrl + '&trackingNumber=' + swiftxNumber, swiftxUrl + '&other=1',
    swiftxUrl + '#test', swiftxUrl.replace(swiftxNumber, 'SWX00000000000000001'), swiftxUrl.replace(swiftxNumber, swiftxNumber.toLowerCase()),
    swiftxUrl.replace(swiftxNumber, `${swiftxNumber},SWX000000000000000002`)]) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [swiftxApi] }), undefined);
  }
  assert.equal(await attachTrackingCapture({}, swiftxUrl, { captureResponses: [swiftxApi + '?other=1'] }), undefined);
});

test('SwiftX captures only the page\'s tracking query for exactly the requested number', async () => {
  const { capture, respond, handlers } = await fixture(swiftxUrl, swiftxApi);
  for (const [method, requestBody] of [['GET', swiftxRequest()], ['POST', null], ['POST', { query: swiftxQuery }],
    ['POST', swiftxRequest({ trackingNos: ['SWX000000000000000002'] })], ['POST', swiftxRequest({ trackingNos: [swiftxNumber], other: 1 })],
    ['POST', swiftxRequest({ trackingNos: [swiftxNumber, 'SWX000000000000000002'] })], ['POST', swiftxRequest({ trackingNos: swiftxNumber })],
    ['POST', swiftxRequest({ trackingNo: swiftxNumber }, 'query GetOfficialWebsiteTrackingInfo { getOfficialWebsiteTrackingInfo(input: $input) { success } }')],
    ['POST', swiftxRequest(undefined, 'query GetOrderPodImages { getOrderPodImages { url } }')]]) {
    await respond(swiftxReply(), { method, requestBody });
  }
  assert.equal(capture.hasResponse(), false);
  assert.equal(capture.hasTrackingRequest(), false);
  handlers.request({ url: () => swiftxApi, method: () => 'POST', postDataJSON: () => swiftxRequest() });
  assert.equal(capture.hasTrackingRequest(), true);
  await respond(swiftxReply(), { method: 'POST', requestBody: swiftxRequest(), headers: { 'set-cookie': 'PRIVATE_COOKIE', 'content-encoding': 'br' } });
  assert.equal(capture.hasResponse(), true);
  await capture.settle(100);
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, swiftxReply());
  assert.deepEqual(rows[0].headers, {});
});

test('SwiftX keeps its not-found reply and challenges without reading refused bodies', async () => {
  const missing = await fixture(swiftxUrl, swiftxApi);
  await missing.respond(swiftxReply(false), { method: 'POST', requestBody: swiftxRequest() });
  await missing.capture.settle(100);
  assert.equal((await missing.capture.drain()).capturedResponses[0].body, swiftxReply(false));
  for (const status of [403, 429]) {
    const { capture, respond } = await fixture(swiftxUrl, swiftxApi);
    await respond('', { method: 'POST', requestBody: swiftxRequest(), status, headers: { 'retry-after': '60' },
      read: () => { throw new Error('must not read rejected body'); } });
    assert.equal(capture.hasResponse(), true);
    const row = (await capture.drain()).capturedResponses[0];
    assert.equal(row.status, status);
    assert.equal(row.body, null);
    assert.equal(row.headers['retry-after'], '60');
  }
});

test('SwiftX preparation leaves the ordinary Turnstile solver its budget when no image is offered', { timeout: 1000 }, async () => {
  const { capture } = await fixture(swiftxUrl, swiftxApi);
  try { await capture.prepare(30_000); }
  finally { await assert.rejects(capture.drain(), /SwiftX produced no tracking response/); }
});

test('SwiftX captures a slider-verified single-number query without retaining its token', async () => {
  const { capture, respond } = await fixture(swiftxUrl, swiftxApi);
  await respond(swiftxReply(), { method: 'POST', requestBody: swiftxRequest({
    trackingNos: [swiftxNumber], humanToken: null, sliderToken: 'SYNTHETIC_SLIDER_TOKEN',
  }) });
  await capture.settle(100);
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, swiftxReply());
  assert.doesNotMatch(JSON.stringify(rows), /SYNTHETIC_SLIDER_TOKEN/);
});

test('SwiftX captures the public phone-skip query but refuses supplied phone and unlock credentials', async () => {
  const input = { trackingNos: [swiftxNumber], sliderToken: 'PRIVATE_SLIDER', phoneLast4: null, unlockToken: null, unlockScope: null };
  const { capture, respond } = await fixture(swiftxUrl, swiftxApi);
  for (const changed of [{ phoneLast4: '1234' }, { phoneLast4: '' }, { unlockToken: 'PRIVATE_UNLOCK' }, { unlockScope: [] },
    { unlockScope: [swiftxNumber] }, { trackingNos: ['SWX000000000000000002'] }]) {
    await respond(swiftxReply(), { method: 'POST', requestBody: swiftxRequest({ ...input, ...changed }) });
  }
  assert.equal(capture.hasResponse(), false);
  const body = JSON.parse(swiftxReply());
  Object.assign(body.data.getOfficialWebsiteTrackingInfoBatch, { unlockToken: 'PRIVATE_CAPABILITY', unlockTokenExpiresInSeconds: 300 });
  await respond(JSON.stringify(body), { method: 'POST', requestBody: swiftxRequest(input) });
  assert.equal(capture.hasResponse(), true);
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, swiftxReply());
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_|unlockToken/);
});

// Synthetic digits.
const swiftxDigits = '0042';
const swiftxPhoneUrl = `${swiftxUrl}#trawl-phone-digits=${swiftxDigits}`;
const swiftxSummary = (trackingNo = swiftxNumber, unlockStatus = 'BASIC') => JSON.stringify({ data: { getOfficialWebsiteTrackingInfoBatch: {
  success: true, results: [{ success: true, trackingNo, unlockStatus, trackingEventList: [] }] } } });

test('SwiftX takes four phone digits in its address\'s fragment and drops them before the page\'s scripts', async () => {
  for (const hash of ['#trawl-phone-digits=042', '#trawl-phone-digits=00042', '#trawl-phone-digits=004a', `#trawl-phone-digits=${swiftxDigits}&x=1`,
    `#trawl-postcode=${swiftxDigits}`]) {
    assert.equal(await attachTrackingCapture({}, swiftxUrl + hash, { captureResponses: [swiftxApi] }), undefined, hash);
  }
  for (const [url, scripts] of [[swiftxPhoneUrl, [swiftxDropPhoneFragment]], [swiftxUrl, []]]) {
    const added = [];
    const { capture } = await fixture(url, swiftxApi, [], { addInitScript: async script => { added.push(script); } });
    assert.ok(capture, url);
    assert.deepEqual(added, scripts, url);
  }
});

test('SwiftX keeps the query carrying the supplied digits, marked, and refuses any other digits', async () => {
  const { capture, respond } = await fixture(swiftxPhoneUrl, swiftxApi);
  const input = { trackingNos: [swiftxNumber], phoneLast4: null, unlockToken: null, unlockScope: null };
  for (const phoneLast4 of ['9999', '', 42, '0042 ']) {
    await respond(swiftxReply(), { method: 'POST', requestBody: swiftxRequest({ ...input, phoneLast4 }) });
  }
  assert.equal(capture.hasResponse(), false);
  await respond(swiftxSummary(), { method: 'POST', requestBody: swiftxRequest(input) });
  await respond(swiftxReply(), { method: 'POST', requestBody: swiftxRequest({ ...input, phoneLast4: swiftxDigits }) });
  const rows = (await capture.drain()).capturedResponses;
  assert.deepEqual(rows.map(row => row.phoneDigitsSubmitted), [undefined, true]);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(swiftxDigits));
});

/** A SwiftX page whose phone field takes typing and whose button posts the query again. */
async function swiftxPhonePage({ url = swiftxPhoneUrl, types = () => true, presses = () => true } = {}) {
  const calls = [];
  let fixtureRef;
  const evaluate = async (fn, arg) => {
    if (fn !== swiftxEnterPhoneDigits) throw new Error('unexpected page script');
    calls.push([arg.submit ? 'press' : 'type', arg.number, arg.digits]);
    if (!arg.submit) return types();
    const pressed = presses();
    if (pressed) setTimeout(() => fixtureRef.respond(swiftxReply(), { method: 'POST', requestBody: swiftxRequest({ trackingNos: [swiftxNumber],
      phoneLast4: arg.digits, unlockToken: null, unlockScope: null }) }), 20);
    return pressed;
  };
  fixtureRef = await fixture(url, swiftxApi, [], { evaluate });
  return { ...fixtureRef, calls };
}

test('SwiftX types the supplied digits once the summary for the number arrives and settles on the reply to them', { timeout: 5000 }, async () => {
  const { capture, respond, calls } = await swiftxPhonePage();
  await respond(swiftxSummary(), { method: 'POST', requestBody: swiftxRequest({ trackingNos: [swiftxNumber], phoneLast4: null }) });
  await capture.settle(5000);
  assert.deepEqual(calls, [['type', swiftxNumber, swiftxDigits], ['press', swiftxNumber, swiftxDigits]]);
  assert.equal(capture.hasResponse(), true);
  const rows = (await capture.drain()).capturedResponses;
  assert.deepEqual(rows.map(row => [row.body, row.phoneDigitsSubmitted]), [[swiftxSummary(), undefined], [swiftxReply(), true]]);
});

test('SwiftX leaves the summary alone without digits, for a full reply or another number, and ends when the field cannot take them', { timeout: 5000 }, async () => {
  for (const [url, body] of [[swiftxUrl, swiftxSummary()], [swiftxPhoneUrl, swiftxSummary(swiftxNumber, 'FULL')],
    [swiftxPhoneUrl, swiftxSummary(swiftxNumber, 'NO_PHONE')], [swiftxPhoneUrl, swiftxSummary('SWX000000000000000002')]]) {
    const { capture, respond, calls } = await swiftxPhonePage({ url });
    await respond(body, { method: 'POST', requestBody: swiftxRequest({ trackingNos: [swiftxNumber] }) });
    const started = Date.now();
    await capture.settle(5000);
    assert.ok(Date.now() - started < 500, body);
    assert.deepEqual(calls, [], body);
    assert.equal((await capture.drain()).capturedResponses.length, 1, body);
  }
  // A field that never shows stops typing within the budget, keeping the summary.
  const absent = await swiftxPhonePage({ types: () => false });
  await absent.respond(swiftxSummary(), { method: 'POST', requestBody: swiftxRequest({ trackingNos: [swiftxNumber] }) });
  await absent.capture.settle(2600);
  assert.ok(absent.calls.length > 1 && absent.calls.every(([step]) => step === 'type'));
  assert.equal(absent.capture.hasResponse(), true);
  assert.equal((await absent.capture.drain()).capturedResponses.length, 1);
  // A button that went away after typing ends the wait at once.
  const gone = await swiftxPhonePage({ presses: () => false });
  await gone.respond(swiftxSummary(), { method: 'POST', requestBody: swiftxRequest({ trackingNos: [swiftxNumber] }) });
  const started = Date.now();
  await gone.capture.settle(5000);
  assert.ok(Date.now() - started < 1000);
  assert.equal(gone.capture.hasResponse(), true);
  assert.deepEqual(gone.calls.map(([step]) => step), ['type', 'press']);
  // Too little time left: no typing at all.
  const late = await swiftxPhonePage();
  await late.respond(swiftxSummary(), { method: 'POST', requestBody: swiftxRequest({ trackingNos: [swiftxNumber] }) });
  await late.capture.settle(2200);
  assert.deepEqual(late.calls, []);
});

test('SwiftX reports a page that never asked for the number and a failed query', async () => {
  const silent = await fixture(swiftxUrl, swiftxApi);
  await silent.capture.settle(1);
  await assert.rejects(silent.capture.drain(), { message: 'SwiftX produced no tracking response after submission' });
  const { capture, handlers } = await fixture(swiftxUrl, swiftxApi);
  const request = { url: () => swiftxApi, method: () => 'POST', postDataJSON: () => swiftxRequest(),
    failure: () => ({ errorText: 'PRIVATE_TOKEN in unexpected network text' }) };
  handlers.request(request);
  handlers.requestfailed(request);
  await capture.settle(100);
  await assert.rejects(capture.drain(), { message: 'SwiftX tracking request failed: network failure' });
});

const speedyApi = 'https://myspeedy.speedy.bg/rest/public/track';
// A made-up number in Speedy's eleven-digit layout, the same one the adapter's tests use.
const speedyNumber = '69000000001';
const speedyUrl = `https://myspeedy.speedy.bg/pub/tracking/${speedyNumber}?language=en`;
const speedyRequest = `${speedyApi}?id=${speedyNumber}&language=en&mobile=N`;

test('Speedy captures only its tracker page for one whole number and the page\'s exact request', async () => {
  for (const url of [speedyUrl.replace('myspeedy.speedy.bg', 'other.test'), speedyUrl.replace('?language=en', ''),
    speedyUrl.replace('en', 'bg'), speedyUrl + '#x', speedyUrl.replace(speedyNumber, '6900000000'), speedyUrl.replace('/pub/', '/pub/x/')]) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [speedyApi] }), undefined);
  }
  assert.equal(await attachTrackingCapture({}, speedyUrl, { captureResponses: [`${speedyApi}?id=${speedyNumber}`] }), undefined);
  const { capture, respond } = await fixture(speedyUrl, speedyApi);
  const budget = new AbortController();
  const solver = capture.solverSignal(budget.signal);
  await respond(JSON.stringify({ barcode: '69000000009', events: [] }), { url: speedyRequest.replace(speedyNumber, '69000000009') });
  await respond(JSON.stringify({ barcode: speedyNumber, events: [] }), { url: speedyRequest.replace('mobile=N', 'mobile=Y') });
  await respond(JSON.stringify({ barcode: speedyNumber, events: [] }), { url: speedyRequest, method: 'POST' });
  assert.equal(capture.hasResponse(), false);
  assert.equal(solver.aborted, false);
  await respond(JSON.stringify({ barcode: speedyNumber, events: [{ operationCode: 1 }] }), { url: speedyRequest });
  // The page's reply ends TRAWL's Turnstile solver, which waits for a token field this page never fills.
  assert.equal(solver.aborted, true);
  assert.equal(budget.signal.aborted, false);
  await capture.settle(100);
  assert.equal(capture.hasResponse(), true);
  const rows = (await capture.drain()).capturedResponses;
  assert.deepEqual(rows.map(row => [row.url, row.status, JSON.parse(row.body).barcode]), [[speedyRequest, 200, speedyNumber]]);
});

test('Speedy keeps the missing-resource page and a refused Turnstile token, and other refusals without their bodies', async () => {
  const page = '<!DOCTYPE html><html><h4>Заявеният ресурс не съществува.</h4></html>';
  const refusal = JSON.stringify([{ context: 'turnstile-failure' }]);
  for (const [status, body, type, kept] of [[404, page, 'text/html;charset=UTF-8', page], [406, refusal, 'application/json', refusal],
    [403, 'blocked', 'text/html', null], [429, 'slow down', 'text/html', null]]) {
    const { capture, respond } = await fixture(speedyUrl, speedyApi);
    await respond(body, { url: speedyRequest, status, headers: { 'content-type': type, 'content-length': undefined, 'retry-after': '60' },
      ...(kept === null ? { read: () => { throw new Error('must not read a refused body'); } } : {}) });
    await capture.settle(100);
    assert.equal(capture.hasResponse(), true);
    const [row] = (await capture.drain()).capturedResponses;
    assert.deepEqual([row.status, row.body, row.error], [status, kept, undefined]);
  }
  const silent = await fixture(speedyUrl, speedyApi);
  await silent.capture.settle(1);
  await assert.rejects(silent.capture.drain(), { message: 'Speedy produced no tracking response after submission' });
  // The installer hands both browser tiers' solvers the capture's signal when it offers one.
  assert.match(readFileSync(new URL('./install.mjs', import.meta.url), 'utf8'),
    /\.replace\(solverSignal, 'solveRemaining,\\n {8}pageCapture\.solverSignal\?\.\(budget\.signal\) \?\? budget\.signal,'\)/);
});

const australiaNumber = '7T0000000000000000001';
const australiaUrl = `https://auspost.com.au/mypost/track/details/${australiaNumber}`;
const australiaApi = `https://digitalapi.auspost.com.au/shipments-gateway/v1/watchlist/shipments?trackingIds=${australiaNumber}`;
const australiaReply = (trackingId = australiaNumber, status = 200) => JSON.stringify([
  { trackingIds: [trackingId], status, ...(status === 200 ? { shipment: { articles: [{ articleId: trackingId }] } } : {}) },
]);

test('Australia Post capture requires the exact public page, number and anonymous GET', async () => {
  for (const url of [australiaUrl.replace('auspost.com.au', 'other.test'), australiaUrl + '?x=1',
    australiaUrl + '#test', australiaUrl.replace('/details/', '/search/'), australiaUrl + ',OTHER123456']) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [australiaApi] }), undefined);
  }
  assert.equal(await attachTrackingCapture({}, australiaUrl, { captureResponses: [australiaApi.replace(australiaNumber, '0000000000000')] }), undefined);
  const { capture, respond } = await fixture(australiaUrl, australiaApi);
  await respond(australiaReply(), { method: 'POST' });
  await respond(australiaReply('0000000000000'));
  assert.equal(capture.hasResponse(), false);
  await respond(australiaReply());
  assert.equal(capture.hasResponse(), true);
  await capture.settle(100);
  assert.equal((await capture.drain()).capturedResponses.length, 2);
});

test('Australia Post stops on a matched negative instead of accepting an app shell', async () => {
  for (const [body, status] of [[australiaReply(australiaNumber, 400), 200]]) {
    const { capture, respond } = await fixture(australiaUrl, australiaApi);
    await respond(body, { status });
    assert.equal(capture.hasResponse(), true);
    await capture.settle(100);
    assert.equal((await capture.drain()).capturedResponses[0].status, status);
  }
  const { capture } = await fixture(australiaUrl, australiaApi);
  await assert.rejects(capture.drain(), /Australia Post produced no tracking response/);
});

function australiaBrowser({ source = 'api:{shipmentsGateway:"synthetic-public-client-config"}', scripts,
  origin = 'https://auspost.com.au', fetcher, budgetMs = 1000, clients } = {}) {
  const calls = [];
  const globals = { URL, AbortController, TextDecoder, setTimeout, clearTimeout,
    location: { origin, href: australiaUrl },
    document: { querySelectorAll: () => (scripts ?? ['https://auspost.com.au/mypost/track/assets/index-example.js']).map(src => ({ src })) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetcher ? fetcher(url, options) : new Response(url.includes('/assets/') ? source : australiaReply());
    },
    args: { number: australiaNumber, budgetMs, ...(clients ? { clients } : {}) },
  };
  return { calls, run: () => runInNewContext(`(${requestAustraliaPostInPage.toString()})(args)`, globals) };
}

test('Australia Post reads current public configuration and submits only the anonymous tracking request', async () => {
  const browser = australiaBrowser();
  assert.equal(await browser.run(), 200);
  assert.equal(browser.calls.length, 2);
  assert.equal(browser.calls[0].options.redirect, 'error');
  const { url, options } = browser.calls[1];
  assert.equal(url, australiaApi);
  assert.equal(options.credentials, 'include');
  assert.equal(options.headers['api-key'], 'synthetic-public-client-config');
  assert.equal(options.headers.AP_CHANNEL_NAME, 'WEB_DETAIL');
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(options.signal.aborted, false);
});

test('Australia Post uses a key already read for the page\'s module without downloading the module again', async () => {
  const known = australiaBrowser({ clients: { '/mypost/track/assets/index-example.js': 'synthetic-known-client-config' } });
  assert.equal(await known.run(), 200);
  assert.deepEqual(known.calls.map(call => call.url), [australiaApi]);
  assert.equal(known.calls[0].options.headers['api-key'], 'synthetic-known-client-config');
  for (const clients of [{ '/mypost/track/assets/index-other.js': 'synthetic-known-client-config' },
    { '/mypost/track/assets/index-example.js': 'not a key' }]) {
    const unknown = australiaBrowser({ clients });
    await unknown.run();
    assert.equal(unknown.calls.length, 2);
    assert.equal(unknown.calls[1].options.headers['api-key'], 'synthetic-public-client-config');
  }
});

test('Australia Post refuses foreign or ambiguous modules and changed public configuration', async () => {
  for (const options of [
    { origin: 'https://other.test' }, { scripts: ['https://other.test/mypost/track/assets/index-example.js'] },
    { scripts: ['https://auspost.com.au/mypost/track/assets/index-a.js', 'https://auspost.com.au/mypost/track/assets/index-b.js'] },
    { source: 'configuration changed' },
    { source: 'shipmentsGateway:"synthetic-public-config-one",shipmentsGateway:"synthetic-public-config-two"' },
  ]) {
    const browser = australiaBrowser(options);
    await assert.rejects(browser.run(), /Australia Post/);
    assert.equal(browser.calls.some(call => call.url === australiaApi), false);
  }
});

test('Australia Post bounds bootstrap bytes and aborts a hanging bootstrap', async () => {
  const tooLarge = australiaBrowser({ source: 'x'.repeat(4_000_001) });
  await assert.rejects(tooLarge.run(), /size limit/);
  assert.equal(tooLarge.calls.length, 1);
  const exhausted = australiaBrowser({ budgetMs: 0 });
  await assert.rejects(exhausted.run(), /budget exhausted/);
  assert.equal(exhausted.calls.length, 0);
  const hanging = australiaBrowser({ budgetMs: 10, fetcher: (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }) });
  await assert.rejects(hanging.run(), /Aborted/);
});

const australiaReport = { url: () => 'https://dd.auspost.com.au/js/' };

test('Australia Post preparation captures history before the generic CAPTCHA solver runs', async () => {
  const { page, capture, respond, handlers } = await fixture(australiaUrl, australiaApi);
  page.evaluate = async (callback, args) => {
    assert.equal(callback, requestAustraliaPostMainWorld);
    assert.equal(args.number, australiaNumber);
    assert.ok(args.budgetMs > 0);
    await respond(australiaReply());
  };
  await handlers.requestfinished(australiaReport);
  await capture.prepare(1000);
  assert.equal(capture.hasResponse(), true);
  await capture.drain();
});

test('Australia Post reads the public key from the module the page loaded and remembers it by path', async () => {
  const modulePath = '/mypost/track/assets/index-loaded.js';
  const { page, capture, respond, handlers, detachedEvents } = await fixture(australiaUrl, australiaApi);
  const source = 'a={shipmentsGateway:"synthetic-loaded-client-config"}';
  await respond(source, { url: `https://auspost.com.au${modulePath}?v=1`, method: 'GET' });
  await respond(source, { url: `https://other.test${modulePath}`, method: 'GET' });
  await respond(source, { url: `https://auspost.com.au${modulePath}`, method: 'GET', status: 304 });
  await respond(source + source, { url: `https://auspost.com.au${modulePath}`, method: 'GET' });
  await capture.prepare(0).catch(() => {});
  assert.equal(australiaPostClientKnown(modulePath), false);
  await respond(source, { url: `https://auspost.com.au${modulePath}`, method: 'GET' });
  page.evaluate = async (callback, args) => {
    assert.equal(callback, requestAustraliaPostMainWorld);
    assert.equal(args.clients[modulePath], 'synthetic-loaded-client-config');
    await respond(australiaReply());
  };
  await handlers.requestfinished(australiaReport);
  await capture.prepare(1000);
  assert.equal(australiaPostClientKnown(modulePath), true);
  await capture.drain();
  assert.ok(detachedEvents.includes('response'));
});

test('Australia Post sends the tracking request only once DataDome has answered its first report', async () => {
  const { page, capture, respond, handlers, detachedEvents } = await fixture(australiaUrl, australiaApi);
  let asked = false;
  page.evaluate = async (_callback, args) => {
    asked = true;
    assert.ok(args.budgetMs > 15_000);
    await respond(australiaReply());
  };
  const preparing = capture.prepare(20_000);
  await handlers.requestfinished({ url: () => 'https://dd.auspost.com.au/tags.js' });
  await handlers.requestfinished({ url: () => 'https://dd.auspost.com.au.other.test/js/' });
  await handlers.requestfinished({ url: () => 'not a URL' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(asked, false);
  const reported = Date.now();
  await handlers.requestfailed(australiaReport);
  await preparing;
  assert.equal(asked, true);
  assert.ok(Date.now() - reported >= 450);
  await capture.drain();
  for (const event of ['requestfinished', 'requestfailed']) assert.ok(detachedEvents.includes(event));
});

test('Australia Post sends the tracking request without DataDome\'s report once half the budget is spent', async () => {
  const { page, capture, respond } = await fixture(australiaUrl, australiaApi);
  page.evaluate = async (_callback, args) => {
    // A timer may fire a millisecond early by the wall clock.
    assert.ok(args.budgetMs > 0 && args.budgetMs <= 205);
    await respond(australiaReply());
  };
  const started = Date.now();
  await capture.prepare(400);
  assert.ok(Date.now() - started >= 190);
  await capture.drain();
});

const ninjaGet = 'https://postal.ninja/track/get';
const ninjaCheck = 'https://postal.ninja/track/check';
const ninjaUrl = `https://postal.ninja/en/tools#trawl-number=${number}`;
const ninjaReply = (fields = {}) => JSON.stringify({status: 'FOUND', hid: 'test-handle', track: {tc: number, hid: 'test-handle', state: 'FINISHED'}, ...fields});

test('Postal Ninja requires an exact tools page, one number and both capture endpoints', async () => {
  for (const url of [ninjaUrl.replace('postal.ninja', 'other.test'), ninjaUrl.replace('/en/tools', '/en'),
    ninjaUrl.replace('#trawl-number=', '?trawl-number='), ninjaUrl + ',OTHER123', ninjaUrl.replace(number, 'LETTERS')]) {
    assert.equal(await attachTrackingCapture({}, url, {captureResponses: [ninjaGet, ninjaCheck]}), undefined);
  }
  assert.equal(await attachTrackingCapture({}, ninjaUrl, {captureResponses: [ninjaGet]}), undefined);
});

test('Postal Ninja waits through processing and pending replies for the exact completed lookup', async () => {
  const { capture, respond } = await fixture(ninjaUrl, ninjaGet, [ninjaCheck]);
  const post = (body, url = ninjaGet) => respond(body, {url, method: 'POST'});
  let settled = false;
  const waiting = capture.settle(1000).then(() => { settled = true; });
  await respond(ninjaReply()); // GET is not the widget protocol.
  await post(JSON.stringify({status: 'PROCESSING', tc: number, hid: 'test-handle'}), ninjaCheck);
  assert.equal(capture.hasTrackingRequest(), true);
  await post(ninjaReply({inProgress: true}));
  await post(ninjaReply({track: {tc: 'OTHER123', hid: 'test-handle'}}));
  await post(ninjaReply({hid: 'mismatched'}));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false);
  await post(ninjaReply()); await waiting;
  assert.equal(capture.hasResponse(), true);
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 5);
  assert.equal(rows[0].url, ninjaCheck);
});

test('Postal Ninja finishes matching challenges and completed empty replies promptly', async () => {
  for (const final of [JSON.stringify({status: 'CHLNG_REQ', hid: 'test-handle'}), JSON.stringify({status: 'UNTRACEABLE', tc: number}), ninjaReply({track: {tc: number, hid: 'test-handle', state: 'NO_INFO'}})]) {
    const { capture, respond } = await fixture(ninjaUrl, ninjaGet, [ninjaCheck]);
    await respond(JSON.stringify({status: 'CHLNG_REQ', tc: 'OTHER123'}), {url: ninjaCheck, method: 'POST'});
    assert.equal(capture.hasResponse(), false);
    await respond(JSON.stringify({status: 'PROCESSING', tc: number, hid: 'test-handle'}), {url: ninjaCheck, method: 'POST'});
    await respond(JSON.stringify({status: 'CHLNG_REQ', hid: 'unrelated'}), {method: 'POST'});
    assert.equal(capture.hasResponse(), false);
    await respond(final, {method: 'POST'});
    assert.equal(capture.hasResponse(), true);
    await capture.settle(1000); await capture.drain();
  }
});

test('Postal Ninja opens only the verified result and waits for full history after compact capture', async () => {
  const {page, capture, respond} = await fixture(ninjaUrl, ninjaGet, [ninjaCheck]);
  let filled;
  let saved = true;
  let submitted = 0;
  let navigated;
  const post = body => respond(body, {method: 'POST'});
  const compact = ninjaReply({track: {tc: number, hid: 'test-handle', state: 'FINISHED', firstEv: {dt: '2026-08-01T10:00:00', dsc: 'Accepted'}}});
  const form = {locator: selector => {
    if (selector === 'input[type="text"]') return {fill: async value => {filled = value;}};
    if (selector === 'input[type="checkbox"]') return {count: async () => 1, uncheck: async () => {saved = false;}};
    return {evaluate: async () => { submitted++; assert.equal(saved, false); await post(compact); return true; }};
  }};
  page.frameLocator = () => ({locator: () => form});
  page.goto = async url => {navigated = url;};
  await capture.prepare(2000);
  assert.equal(filled, number);
  assert.equal(submitted, 1);
  assert.equal(navigated, 'https://postal.ninja/en/track#/test-handle');
  let settled = false;
  const waiting = capture.settle(1000).then(() => {settled = true;});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false);
  await post(ninjaReply({track: {tc: number, hid: 'test-handle', state: 'FINISHED', events: [{dt: '2026-08-01T10:00:00', dsc: 'Accepted'}]}}));
  await waiting;
  assert.equal((await capture.drain()).capturedResponses.length, 2);
});

test('Postal Ninja never follows an unsafe or unrelated result handle', async () => {
  for (const [tc, hid] of [[number, '//other.test'], ['OTHER123', 'test-handle']]) {
    const {page, capture, respond} = await fixture(ninjaUrl, ninjaGet, [ninjaCheck]);
    page.frameLocator = () => ({locator: () => ({locator: selector => selector === 'input[type="text"]'
      ? {fill: async () => {}}
      : selector === 'input[type="checkbox"]' ? {count: async () => 0}
        : {evaluate: async () => {await respond(ninjaReply({hid, track: {tc, hid, firstEv: {dt: '2026-08-01T10:00:00'}}}), {method: 'POST'}); return true;}}})});
    page.goto = () => {throw new Error('Must not navigate');};
    await capture.prepare(10);
    await capture.drain();
  }
});

test('reads decoded compressed history and waits through polling for a final matching reply', async () => {
  const { capture, respond } = await fixture();
  let settled = false;
  const waiting = capture.settle(1000).then(() => { settled = true; });
  await respond(reply(100)); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false);
  await respond(reply(200)); await waiting;
  assert.deepEqual((await capture.drain()).capturedResponses.map(r => JSON.parse(r.body).shipments[0].code), [100, 200]);
});

test('17TRACK submits the postcode through the normal form after a matching prompt and retains both replies', async () => {
  const postcode = 'AB1 2CD';
  const { capture, respond, page } = await fixture(`https://t.17track.net/en#nums=${number}&trawl-postcode=${encodeURIComponent(postcode)}`);
  let filled, submitted = 0;
  page.getByText = (text, options) => {
    assert.equal(options.exact, true);
    if (text === number) return { first: () => ({ waitFor: async () => {} }) };
    assert.equal(text, 'reference');
    return { click: async () => {} };
  };
  page.getByRole = role => {
    assert.equal(role, 'dialog');
    return { locator: selector => {
      if (selector === 'input[name="postal_code"]') return { fill: async value => { filled = value; } };
      assert.equal(selector, 'button[type="submit"]');
      return { click: async () => {
        submitted++;
        await respond(reply(100), { requestBody: { data: [{ num: number, params_v2: { postal_code: filled } }] } });
        await respond(reply(200), { requestBody: { data: [{ num: number, params_v2: { postal_code: filled } }] } });
      } };
    } };
  };
  await respond(JSON.stringify({ meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, params_v2: [{ key: 'postal_code' }] }] }));
  await capture.prepare(1000);
  assert.equal(filled, postcode);
  assert.equal(submitted, 1);
  const rows = (await capture.drain()).capturedResponses;
  assert.deepEqual(rows.map(r => r.postcodeSubmitted === true), [false, true, true]);
});

test('17TRACK binds requests to one number and does not mark another postcode as submitted', async () => {
  const { capture, respond } = await fixture(`https://t.17track.net/en#nums=${number}&trawl-postcode=8000`);
  await respond(reply(400), { requestBody: { data: [{ num: 'OTHER123', params_v2: { postal_code: '8000' } }] } });
  await respond(reply(400), { requestBody: { data: [{ num: number }, { num: 'OTHER123' }] } });
  assert.equal(capture.hasResponse(), false);
  await respond(reply(400), { requestBody: { data: [{ num: number, params_v2: { postal_code: '9999' } }] } });
  assert.equal((await capture.drain()).capturedResponses[0].postcodeSubmitted, undefined);
});

test('17TRACK leaves a completed lookup alone and does not expose form errors containing private input', async () => {
  const { capture, respond } = await fixture(`https://t.17track.net/en#nums=${number}&trawl-postcode=8000`);
  await respond(reply(200));
  await capture.prepare(1000);
  await capture.drain();
  const gated = await fixture(`https://t.17track.net/en#nums=${number}&trawl-postcode=8000`);
  gated.page.getByText = () => { throw new Error(`${number}: 8000`); };
  await gated.respond(JSON.stringify({ meta: { code: 200 }, shipments: [{ number, code: 400, shipment: null, params_v2: [{ key: 'postal_code' }] }] }));
  await assert.rejects(gated.capture.prepare(1000), { message: '17TRACK postcode form could not complete' });
  await gated.capture.drain();
});

test('ignores unrelated endpoints and rejects oversized declared and decoded bodies', async () => {
  const { capture, respond } = await fixture();
  await respond(reply(200), { url: 'https://unrelated.example/track/restapi' });
  await respond(reply(200), { headers: { 'content-length': '2000001' }, read: () => { throw new Error('must not read'); } });
  await respond('x'.repeat(2_000_001), { headers: { 'content-length': '1000' } });
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.body === null && row.error));
  assert.equal(rows[1].truncated, true);
});

test('rate limits finish immediately and preserve Retry-After without cookies', async () => {
  const { capture, respond } = await fixture();
  await respond('', { status: 429, headers: { 'retry-after': '300', cookie: 'PRIVATE' } });
  await capture.settle(1000);
  const result = await capture.drain();
  assert.equal(result.capturedResponses[0].headers['retry-after'], '300');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('bounds hanging body reads and detaches without accepting late replies', async () => {
  const { capture, respond, detached } = await fixture();
  let release;
  const reading = respond(reply(200), { read: () => new Promise(resolve => { release = resolve; }) });
  await capture.settle(1); const snapshot = await capture.drain();
  release(Buffer.from(reply(200))); await reading;
  assert.equal(snapshot.capturedResponses[0].body, null);
  assert.equal(detached(), true);
});

test('does not finish on a demo or alter other providers and multi-number lookups', async () => {
  const { capture, respond } = await fixture();
  await respond(reply(200).replace(number, 'TestNumber00017'));
  await capture.settle(1);
  for (const url of ['https://parcelsapp.com/en/tracking/ZZ12345678900', 'https://t.17track.net/en#nums=ZZ12345,ZZ54321']) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [api] }), undefined);
  }
});

test('reads the decoded UPS status reply and finishes on the requested shipment', async () => {
  const { capture, respond } = await fixture(upsUrl, upsApi);
  let settled = false;
  const waiting = capture.settle(1000).then(() => { settled = true; });
  await respond(upsReply('1Z000AA10000000000')); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false);
  await respond(upsReply()); await waiting;
  const rows = (await capture.drain()).capturedResponses;
  assert.deepEqual(rows.map(row => JSON.parse(row.body).trackDetails[0].trackingNumber), ['1Z000AA10000000000', upsNumber]);
});

test('finishes on a rejected UPS status envelope and only serves one valid number per page', async () => {
  const { capture, respond } = await fixture(upsUrl, upsApi);
  await respond(upsReply(upsNumber, '500'));
  await capture.settle(1000);
  assert.equal((await capture.drain()).capturedResponses.length, 1);
  for (const [url, endpoint] of [
    ['https://www.ups.com/track?loc=en_US&tracknum=not-a-ups-number', upsApi],
    ['https://www.ups.com/track/details?tracknum=' + upsNumber, upsApi],
    [upsUrl, api],
    [`https://t.17track.net/en#nums=${number}`, upsApi],
  ]) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [endpoint] }), undefined);
  }
});

test('UPS keeps the latest twenty replies and a twenty-first refusal without reading private bodies', async () => {
  const { capture, respond } = await fixture(upsUrl, upsApi);
  for (let i = 0; i < 20; i += 1) await respond(upsReply());
  for (const status of [428, 429]) {
    await respond('PRIVATE REFUSAL', { status, headers: { 'retry-after': '60', 'set-cookie': 'PRIVATE COOKIE', authorization: 'PRIVATE TOKEN' },
      read: () => { throw new Error('private refusal body must not be read'); } });
  }
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 20);
  assert.deepEqual(rows.slice(-2).map(row => row.status), [428, 429]);
  assert.deepEqual(rows.at(-1), { url: upsApi, status: 429, body: null, headers: { 'retry-after': '60' }, truncated: false, base64Encoded: false });
  assert.equal(JSON.stringify(rows).includes('PRIVATE'), false);
});

test('UPS observes only the exact POST for one whole requested identifier and detaches all handlers', async () => {
  const { capture, respond, handlers, detachedEvents } = await fixture(upsUrl, upsApi);
  for (const [method, requestBody, url] of [
    ['GET', { TrackingNumber: [upsNumber] }, upsApi],
    ['OPTIONS', { TrackingNumber: [upsNumber] }, upsApi],
    ['POST', null, upsApi],
    ['POST', { TrackingNumber: upsNumber }, upsApi],
    ['POST', { TrackingNumber: [1234567890] }, upsApi],
    ['POST', { TrackingNumber: ['1Z000AA10000000000'] }, upsApi],
    ['POST', { TrackingNumber: [upsNumber, '1Z000AA10000000000'] }, upsApi],
    ['POST', { TrackingNumber: [upsNumber + 'EXTRA'] }, upsApi],
    ['POST', { TrackingNumber: [upsNumber] }, upsApi + '&unrelated=true'],
  ]) {
    // More than twenty unrelated attempts must not consume the real capture.
    for (let i = 0; i < 3; i += 1) {
      const request = { url: () => url, method: () => method, postDataJSON: () => requestBody,
        failure: () => ({ errorText: 'PRIVATE FAILURE' }) };
      handlers.request(request);
      handlers.requestfailed(request);
      await respond('', { method, requestBody, url, status: 429, read: () => { throw new Error('wrong request body must not be read'); } });
    }
  }
  const malformed = { url: () => upsApi, method: () => 'POST', postDataJSON: () => { throw new Error('PRIVATE JSON'); } };
  handlers.request(malformed);
  assert.equal(capture.hasTrackingRequest(), false);
  assert.equal(capture.hasResponse(), false);
  const valid = { url: () => upsApi, method: () => 'POST', postDataJSON: () => ({ TrackingNumber: [upsNumber.toLowerCase()] }) };
  handlers.request(valid);
  assert.equal(capture.hasTrackingRequest(), true);
  await respond(upsReply());
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, upsReply());
  assert.deepEqual(detachedEvents.sort(), ['request', 'requestfailed', 'response']);
});

test('UPS keeps refusal metadata after the cumulative body budget without resetting it when rows roll', async () => {
  const { capture, respond } = await fixture(upsUrl, upsApi);
  const large = JSON.stringify({ statusCode: '200', trackDetails: [{ trackingNumber: upsNumber }], padding: 'x'.repeat(1_500_000) });
  for (let i = 0; i < 3; i += 1) await respond(large);
  for (let i = 0; i < 25; i += 1) {
    await respond(upsReply(), { read: () => { throw new Error('spent body budget must not be read'); } });
  }
  await respond('PRIVATE', { status: 429, headers: { 'retry-after': '120', cookie: 'PRIVATE' },
    read: () => { throw new Error('refusal body must not be read'); } });
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 20);
  assert.equal(rows.at(-1).status, 429);
  assert.deepEqual(rows.at(-1).headers, { 'retry-after': '120' });
  assert.ok(rows.every(row => row.body === null));
  assert.ok(rows.slice(0, -1).every(row => row.error));
  assert.equal(JSON.stringify(rows).includes('PRIVATE'), false);
});

test('UPS bounds successful body extraction while retaining later unreadable or refused rows', async () => {
  const { capture, respond } = await fixture(upsUrl, upsApi);
  let reads = 0;
  for (let i = 0; i < 25; i += 1) await respond(upsReply(), { read: async () => { reads += 1; return Buffer.from(upsReply()); } });
  await respond('', { status: 403, headers: { 'retry-after': '30' } });
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(reads, 20);
  assert.equal(rows.length, 20);
  assert.ok(rows.at(-2).error);
  assert.equal(rows.at(-2).body, null);
  assert.equal(rows.at(-1).status, 403);
});

test('UPS preserves asynchronous response arrival order and ignores body completion after cleanup', async () => {
  const { capture, respond } = await fixture(upsUrl, upsApi);
  let release;
  const first = respond(upsReply(), { read: () => new Promise(resolve => { release = resolve; }) });
  await respond('', { status: 429, headers: { 'retry-after': '90' } });
  const snapshot = await capture.drain();
  release(Buffer.from(upsReply()));
  await first;
  assert.deepEqual(snapshot.capturedResponses.map(row => row.status), [200, 429]);
  assert.equal(snapshot.capturedResponses[0].body, null);
  assert.deepEqual(snapshot.capturedResponses[1].headers, { 'retry-after': '90' });
});

test('UPS sanitizes a bound request failure without retaining request bodies or private failure details', async () => {
  const { capture, handlers } = await fixture(upsUrl, upsApi);
  const request = { url: () => upsApi, method: () => 'POST', postDataJSON: () => ({ TrackingNumber: [upsNumber] }),
    failure: () => ({ errorText: 'PRIVATE REQUEST FAILURE' }) };
  handlers.request(request);
  handlers.requestfailed(request);
  await assert.rejects(capture.drain(), { message: 'UPS tracking request failed: network failure' });
});

test('UPS does not conceal a newer request failure behind old history but accepts a later matching recovery', async () => {
  for (const recovered of [false, true]) {
    const { capture, handlers, respond } = await fixture(upsUrl, upsApi);
    await respond(upsReply());
    handlers.requestfailed({ url: () => upsApi, method: () => 'POST', postDataJSON: () => ({ TrackingNumber: [upsNumber] }),
      failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) });
    if (!recovered) {
      await assert.rejects(capture.drain(), { message: 'UPS tracking request failed: net::ERR_CONNECTION_RESET' });
    } else {
      await respond('', { status: 429, headers: { 'retry-after': '30' } });
      const rows = (await capture.drain()).capturedResponses;
      assert.deepEqual(rows.map(row => row.status), [200, 429]);
    }
  }
});

test('other collectors keep their original first twenty response bound', async () => {
  const { capture, respond } = await fixture();
  for (let i = 0; i < 20; i += 1) await respond(reply(200));
  await respond('', { status: 429, headers: { 'retry-after': '60' } });
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 20);
  assert.ok(rows.every(row => row.status === 200));
});

test('reads the decoded FedEx tracking reply and finishes on its envelope', async () => {
  const { capture, respond } = await fixture(fedexUrl, fedexApi);
  let settled = false;
  const waiting = capture.settle(1000).then(() => { settled = true; });
  await respond(JSON.stringify({ output: { packages: [] } }));
  await waiting;
  assert.equal(settled, true);
  const rows = (await capture.drain()).capturedResponses;
  assert.deepEqual(rows.map(row => JSON.parse(row.body).output.packages.length), [0]);
});

test('serves the FedEx endpoint from either tracking page path and only for valid numbers', async () => {
  const { capture, respond } = await fixture(`https://www.fedex.com/fedextrack/?trknbr=${fedexNumber}`, fedexApi);
  assert.ok(capture);
  await respond(fedexReply());
  await capture.settle(1000);
  assert.deepEqual((await capture.drain()).capturedResponses.map(row => JSON.parse(row.body).output.packages[0].trackingNbr), [fedexNumber]);
  // A made-up twenty-digit Ground Economy number.
  const groundEconomy = '61299999999900000010';
  const economy = await fixture(`https://www.fedex.com/fedextrack/?trknbr=${groundEconomy}`, fedexApi);
  assert.ok(economy.capture);
  await economy.respond(fedexReply(groundEconomy));
  await economy.capture.settle(1000);
  assert.deepEqual((await economy.capture.drain()).capturedResponses.map(row => JSON.parse(row.body).output.packages[0].trackingNbr), [groundEconomy]);
  for (const [url, endpoint] of [
    ['https://www.fedex.com/wtrk/track/?trknbr=6129999999990000001', fedexApi],
    ['https://www.fedex.com/wtrk/track/?trknbr=not-a-fedex-number', fedexApi],
    ['https://www.fedex.com/wtrk/track/', fedexApi],
    ['https://www.fedex.com/fedextrack/system-error?trknbr=' + fedexNumber, fedexApi],
    [fedexUrl, upsApi],
    [`https://t.17track.net/en#nums=${number}`, fedexApi],
  ]) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [endpoint] }), undefined);
  }
});

const royalMailApiPrefix = 'https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/';
// A made-up number in Royal Mail's published S10 format, the same one the adapter's tests use.
const royalMailNumber = 'SG999999999GB';
const royalMailUrl = `https://www.royalmail.com/track-your-item#/tracking-results/${royalMailNumber}`;
const royalMailApi = `${royalMailApiPrefix}${royalMailNumber}`;
const royalMailReply = (mailPieceId = royalMailNumber) => JSON.stringify({ mailPieceId });

test('reads the decoded Royal Mail summary reply and finishes on its envelope', async () => {
  const { capture, respond } = await fixture(royalMailUrl, royalMailApi);
  assert.ok(capture);
  let settled = false;
  const waiting = capture.settle(1000).then(() => { settled = true; });
  await respond(royalMailReply());
  await waiting;
  assert.equal(settled, true);
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, royalMailApi);
  assert.deepEqual(JSON.parse(rows[0].body).mailPieceId, royalMailNumber);
});

test('serves the Royal Mail endpoint only from its hash route with a valid number', async () => {
  for (const [url, endpoint] of [
    ['https://www.royalmail.com/track-your-item#/tracking-results/not-a-number', `${royalMailApiPrefix}NOT-A-NUMBER`],
    ['https://www.royalmail.com/track-your-item', royalMailApi],
    ['https://www.royalmail.com/track-your-item#/tracking-results/SG999999999GB', upsApi],
    [`https://t.17track.net/en#nums=${number}`, royalMailApi],
  ]) {
    assert.equal(await attachTrackingCapture({}, url, { captureResponses: [endpoint] }), undefined);
  }
});


test('Royal Mail captures only the exact number and rejects unrelated page paths', async () => {
  const { capture, respond } = await fixture(royalMailUrl, royalMailApi);
  await respond(royalMailReply('SG999999998GB'), {url: royalMailApiPrefix + 'SG999999998GB'});
  await respond(royalMailReply(), {url: royalMailApi + '/extra'});
  await assert.rejects(capture.drain(), /no tracking response/);
  for (const [url, endpoint] of [
    [royalMailUrl.replace('/track-your-item', '/other-page'), royalMailApi],
    [royalMailUrl, royalMailApiPrefix + 'SG999999998GB'],
    [royalMailUrl, royalMailApi + '.evil.example'],
  ]) assert.equal(await attachTrackingCapture({}, url, {captureResponses: [endpoint]}), undefined);
});

test('Royal Mail prepares the form after capture attaches and before solving', async () => {
  const calls = [];
  let consentVisible = true;
  const page = {
    context: () => ({addCookies: async () => {}}),
    on: event => { if (event === 'response') calls.push('observe'); },
    waitForEvent: async event => { calls.push(['wait', event]); },
    getByText: () => ({waitFor: async () => {}, isVisible: async () => consentVisible, evaluate: async () => { consentVisible = false; calls.push('decline'); }}),
    locator: selector => ({
      waitFor: async () => {},
      inputValue: async () => royalMailNumber,
      press: async value => calls.push([selector, value]),
      pressSequentially: async value => calls.push(['type', value]),
      evaluate: async () => { calls.push(selector); return true; },
    }),
  };
  const capture = await attachTrackingCapture(page, royalMailUrl, {captureResponses: [royalMailApi]});
  await capture.prepare(1000);
  assert.deepEqual(calls, ['observe', ['wait', 'domcontentloaded'], 'decline', ['#barcode-input', 'ControlOrMeta+A'], ['#barcode-input', 'Backspace'], ['type', royalMailNumber], '#submit:not(:disabled)']);
  await assert.rejects(capture.prepare(0), /timed out/);
});

test('Royal Mail waits for consent reload before typing into the replacement form', async () => {
  let finishReload;
  let loaded = false;
  let value = '';
  let responseHandler;
  let submitted = false;
  const page = {
    context: () => ({addCookies: async () => {}}),
    on: (event, fn) => { if (event === 'response') responseHandler = fn; },
    waitForEvent: () => new Promise(resolve => { finishReload = resolve; }),
    getByText: () => ({
      waitFor: async () => {}, isVisible: async () => true,
      evaluate: async () => { setTimeout(() => { value = ''; loaded = true; finishReload?.(); }, 10); },
    }),
    locator: selector => ({
      waitFor: async () => {}, press: async () => {}, inputValue: async () => value,
      pressSequentially: async text => { assert.equal(loaded, true); value = text; },
      evaluate: async (fn, expected) => fn({
        ownerDocument: { querySelector: () => ({ value }) },
        click() {
          assert.equal(selector, '#submit:not(:disabled)');
          submitted = true;
          responseHandler({url: () => royalMailApi, status: () => 200,
            request: () => ({method: () => 'GET'}), headers: () => ({'content-type': 'application/json'}),
            body: async () => Buffer.from(royalMailReply())});
        },
      }, expected),
    }),
  };
  const capture = await attachTrackingCapture(page, royalMailUrl, {captureResponses: [royalMailApi]});
  await capture.prepare(1000);
  assert.equal(submitted, true);
  assert.equal(capture.hasResponse(), true);
});

test('Royal Mail refuses an empty replacement form when navigation races the final click', async () => {
  let value = royalMailNumber;
  let submitted = false;
  const page = {
    context: () => ({addCookies: async () => {}}),
    on: () => {},
    getByText: () => ({waitFor: async () => {}, isVisible: async () => false}),
    locator: selector => ({
      waitFor: async () => { if (selector === '#submit:not(:disabled)') value = ''; },
      press: async () => {}, pressSequentially: async () => {}, inputValue: async () => value,
      evaluate: async (fn, expected) => fn({
        ownerDocument: {querySelector: () => ({value})}, click() { submitted = true; },
      }, expected),
    }),
  };
  const capture = await attachTrackingCapture(page, royalMailUrl, {captureResponses: [royalMailApi]});
  await assert.rejects(capture.prepare(1000), /input was reset/);
  assert.equal(submitted, false);
});


test('Royal Mail ignores preflight and captures the carrier error body without flattening it to not-found', async () => {
  const {capture, respond} = await fixture(royalMailUrl, royalMailApi);
  await respond('', {method: 'OPTIONS', status: 401});
  const body = JSON.stringify({httpCode: 404, errors: [{errorCode: 'E1142'}]});
  await respond(body, {status: 404});
  await capture.settle(100);
  assert.equal(capture.hasResponse(), true);
  const rows = (await capture.drain()).capturedResponses;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, body);
});

test('Royal Mail opts out before navigation without adding identity cookies or altering other sites', async () => {
  const cookies = [];
  const page = {on() {}, context: () => ({addCookies: async values => cookies.push(...values)})};
  await attachTrackingCapture(page, upsUrl, {captureResponses: [upsApi]});
  assert.equal(cookies.length, 0);
  await attachTrackingCapture(page, royalMailUrl, {captureResponses: [royalMailApi]});
  assert.deepEqual(cookies.map(cookie => cookie.name).sort(), [
    'cmapi_cookie_privacy', 'cmapi_gtm_bl', 'notice_gdpr_prefs', 'notice_preferences',
  ]);
  assert.equal(cookies.find(cookie => cookie.name === 'cmapi_cookie_privacy').value, 'permit 1 required');
  assert.ok(cookies.every(cookie => cookie.domain === '.royalmail.com'
    && cookie.secure && cookie.sameSite === 'Lax' && cookie.expires === undefined));
});

test('Royal Mail reports connection failure promptly and skips form resubmission after verification', {timeout: 1000}, async () => {
  const {capture, handlers, detached} = await fixture(royalMailUrl, royalMailApi);
  const request = {url: () => royalMailApi, method: () => 'GET', failure: () => ({errorText: 'NS_ERROR_NET_RESET'})};
  handlers.request(request);
  handlers.requestfailed(request);
  assert.equal(capture.hasTrackingRequest(), true);
  assert.equal(capture.hasResponse(), false);
  // The fixture has no form methods: this must not try to submit again.
  await capture.prepare(5000);
  await capture.settle(5000);
  await assert.rejects(capture.drain(), {message: 'Royal Mail tracking request failed: NS_ERROR_NET_RESET'});
  assert.equal(detached(), true);
});

test('Royal Mail ignores unrelated failures and never includes arbitrary network error text', async () => {
  const {capture, handlers} = await fixture(royalMailUrl, royalMailApi);
  const request = (url, method = 'GET') => ({url: () => url, method: () => method,
    failure: () => ({errorText: 'PRIVATE_COOKIE https://example.test/?token=PRIVATE_TOKEN'})});
  for (const item of [request(royalMailApi, 'OPTIONS'), request(royalMailApiPrefix + 'SG999999998GB')]) {
    handlers.request(item); handlers.requestfailed(item);
  }
  assert.equal(capture.hasTrackingRequest(), false);
  handlers.request(request(royalMailApi)); handlers.requestfailed(request(royalMailApi));
  await assert.rejects(capture.drain(), {message: 'Royal Mail tracking request failed: network failure'});
});

test('Royal Mail retains an automatic tracking reply without starting another lookup', async () => {
  const {capture, handlers, respond} = await fixture(royalMailUrl, royalMailApi);
  handlers.request({url: () => royalMailApi, method: () => 'GET'});
  await respond(royalMailReply());
  await capture.prepare(1000);
  assert.equal(capture.hasTrackingRequest(), true);
  assert.equal((await capture.drain()).capturedResponses.length, 1);
});

for (const codeField of ['errorCode', 'code']) test(`Royal Mail waits for session refresh with ${codeField}`, {timeout: 1000}, async () => {
  const {capture, handlers, respond} = await fixture(royalMailUrl, royalMailApi);
  handlers.request({url: () => royalMailApi, method: () => 'GET'});
  const denied = JSON.stringify({errors: [{[codeField]: 'E0015'}]});
  await respond(denied, {status: 401});
  let settled = false;
  const waiting = capture.settle(500).then(() => {settled = true;});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(settled, false);
  // The page is already refreshing its challenge; no second solver is needed.
  assert.equal(capture.hasTrackingRequest(), true);
  assert.equal(capture.hasResponse(), true);
  await respond(royalMailReply());
  await waiting;
  assert.deepEqual((await capture.drain()).capturedResponses.map(row => row.status), [401, 200]);
});

test('Royal Mail preserves a rejected session when automatic recovery never arrives', {timeout: 1000}, async () => {
  const {capture, respond} = await fixture(royalMailUrl, royalMailApi);
  const denied = JSON.stringify({errors: [{errorCode: 'E0015'}]});
  await respond(denied, {status: 401});
  await capture.settle(10);
  assert.equal((await capture.drain()).capturedResponses[0].body, denied);
});

test('Royal Mail ends repeated challenge failures and other final errors promptly', {timeout: 1000}, async () => {
  const denied = JSON.stringify({errors: [{errorCode: 'E0015'}]});
  for (const [status, body, firstDenied] of [
    [401, denied, true],
    [401, JSON.stringify({errors: [{errorCode: 'E9999'}]}), false],
    [403, denied, false],
    [429, JSON.stringify({httpCode: '429'}), false],
  ]) {
    const {capture, respond} = await fixture(royalMailUrl, royalMailApi);
    if (firstDenied) await respond(denied, {status: 401});
    await respond(body, {status});
    await capture.settle(5000);
    const rows = (await capture.drain()).capturedResponses;
    assert.equal(rows.at(-1).body, body);
  }
});

test('a capture ends its waits before the service deadline and keeps its other methods', async () => {
  const waits = [];
  const capture = reserveDeadline({ prepare: async budgetMs => { waits.push(['prepare', budgetMs]); },
    settle: async budgetMs => { waits.push(['settle', budgetMs]); }, drain: async () => 'drained', hasResponse: () => true }, 2500);
  await capture.prepare(10_000);
  await capture.settle(4000);
  await capture.settle(1000);
  assert.deepEqual(waits, [['prepare', 7500], ['settle', 1500], ['settle', 0]]);
  assert.equal(await capture.drain(), 'drained');
  assert.equal(capture.hasResponse(), true);
  assert.equal(capture.archive('https://example.test/', ''), undefined);
  const stock = reserveDeadline({ settle: async () => {}, drain: async () => ({}), archive: () => 'archive' }, 2500);
  assert.equal(stock.prepare, undefined);
  assert.equal(stock.archive(), 'archive');
});

test('Australia Post retains an intermediate 403 until the native wrapper yields bound history', async () => {
  const { page, capture, respond, handlers } = await fixture(australiaUrl, australiaApi);
  page.evaluate = async (_callback, args) => {
    assert.equal(args.source, requestAustraliaPostInPage.toString());
    await respond('', { status: 403 });
    assert.equal(capture.hasResponse(), false);
    // Fetch resolves at headers; the capture still has to finish reading its final body.
    setTimeout(() => { void respond(australiaReply(), { read: async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return Buffer.from(australiaReply());
    } }); }, 5);
    return 200;
  };
  await handlers.requestfinished(australiaReport);
  await capture.prepare(1000);
  const rows = (await capture.drain()).capturedResponses;
  assert.deepEqual(rows.map(row => row.status), [403, 200]);
  assert.equal(rows[0].body, null);
  assert.equal(rows[1].body, australiaReply());
});

test('Australia Post ends promptly when the native wrapper finishes with a refusal', async () => {
  const { page, capture, respond, handlers } = await fixture(australiaUrl, australiaApi);
  page.evaluate = async () => { await respond('', { status: 403 }); return 403; };
  await handlers.requestfinished(australiaReport);
  const started = Date.now();
  await capture.prepare(5000);
  assert.ok(Date.now() - started < 1500);
  assert.equal((await capture.drain()).capturedResponses[0].status, 403);
});

test('Australia Post main-world bridge uses the page realm and removes its ephemeral nodes', async () => {
  const { parseHTML } = await import('linkedom');
  const { document, MutationObserver } = parseHTML('<html><head><script nonce="synthetic-nonce"></script></head><body></body></html>');
  const append = document.head.append.bind(document.head);
  const pageWorld = { document, Promise, mainPageWorld: true };
  pageWorld.window = pageWorld;
  document.head.append = (...nodes) => {
    append(...nodes);
    const script = nodes.find(node => node.tagName === 'SCRIPT');
    if (script) { assert.equal(script.nonce, 'synthetic-nonce'); runInNewContext(script.textContent, pageWorld); }
  };
  const request = async () => { if (!window.mainPageWorld) throw Error('PRIVATE_PAGE_ERROR'); return 200; };
  const run = (origin = 'https://auspost.com.au', source = request.toString(), budgetMs = 100) => runInNewContext(
    `(${requestAustraliaPostMainWorld.toString()})({number:'7T0000000000000000001',budgetMs,source})`,
    { location: { origin }, window: {}, document, MutationObserver, setTimeout, clearTimeout, budgetMs, source });
  assert.equal(await run(), 200);
  assert.equal(document.querySelectorAll('meta[name^="au-request-"]').length, 0);
  await assert.rejects(run('https://other.test'), /context is invalid/);
  await assert.rejects(run(undefined, 'async()=>{throw Error("PRIVATE_PAGE_ERROR")}'), error => !error.message.includes('PRIVATE_PAGE_ERROR'));
  await assert.rejects(run(undefined, 'async()=>new Promise(()=>{})', 10), /deadline exceeded/);
  assert.equal(document.querySelectorAll('meta[name^="au-request-"]').length, 0);
  assert.equal(document.querySelectorAll('script').length, 1);
});

// Whether the wait ended within a few turns, without waiting for it.
const ended = async wait => Promise.race([wait.then(() => true), new Promise(resolve => setTimeout(resolve, 20, false))]);
const pending = () => new Promise(() => {});
const sent = (num, url = api, method = 'POST') => ({ url: () => url, method: () => method, postDataJSON: () => ({ data: [{ num }] }) });

test('a page without a capture that names its readiness keeps the whole wait', async () => {
  const { page } = await fixture(upsUrl, upsApi);
  assert.equal(await ended(untilPageReady(pending(), page)), false);
  assert.equal(await ended(untilPageReady(pending(), false)), false);
  assert.equal(await ended(untilPageReady(pending(), {})), false);
  assert.equal(await untilPageReady(Promise.resolve('waited'), page), 'waited');
  await assert.rejects(untilPageReady(Promise.reject(new Error('aborted')), false), /aborted/);
});

test('17TRACK ends the wait for a quiet page once the page asks for the number', async () => {
  const { page, capture, handlers } = await fixture();
  const wait = untilPageReady(pending(), page);
  await handlers.request(sent('OTHER12345'));
  await handlers.request(sent(number, api, 'GET'));
  await handlers.request(sent(number, 'https://t.17track.net/track/other'));
  assert.equal(await ended(wait), false);
  await handlers.request(sent(number));
  assert.equal(await ended(wait), true);
  assert.equal(await ended(untilPageReady(pending(), page)), true);
  // A wait that fails first still fails, and one that fails later is not left unhandled.
  await assert.rejects(untilPageReady(Promise.reject(new Error('aborted')), page), /aborted/);
  await untilPageReady(new Promise((_, reject) => setTimeout(reject, 5, new Error('late'))), page);
  await new Promise(resolve => setTimeout(resolve, 10));
  await capture.drain().catch(() => {});
  assert.equal(await ended(untilPageReady(pending(), page)), false);
});

test('17TRACK ends the wait when a final reply arrives without an observed request', async () => {
  const { page, respond } = await fixture();
  const wait = untilPageReady(pending(), page);
  assert.equal(await ended(wait), false);
  await respond('', { status: 429 });
  assert.equal(await ended(wait), true);
});

test('Postal Ninja ends the wait once its widget shows the form, and keeps it when the widget never does', async () => {
  for (const [mounts, expected] of [[true, true], [false, false]]) {
    const { page } = await fixture(ninjaUrl, ninjaGet, [ninjaCheck]);
    const asked = [];
    page.frameLocator = frame => ({ locator: selector => ({ waitFor: async options => {
      asked.push([frame, selector, options.state]);
      if (!mounts) throw new Error('Timeout');
    } }) });
    assert.equal(await ended(untilPageReady(pending(), page)), expected);
    assert.equal(await ended(untilPageReady(pending(), page)), expected);
    assert.deepEqual(asked, [['iframe[title="Package tracking widget"]', 'form.tracker button[type="submit"]', 'visible']]);
  }
});

test('names pictures, fonts, advertising and measurement as unread, never navigations or Cloudflare checks', () => {
  const request = (url, type = 'script', navigation = false) => ({ url: () => url, resourceType: () => type, isNavigationRequest: () => navigation });
  for (const [url, type] of [['https://t.17track.net/assets/banner.png', 'image'], ['https://static.17track.net/font.woff2', 'font'],
    ['https://postal.ninja/intro.mp4', 'media'], ['https://securepubads.g.doubleclick.net/tag/js/gpt.js'],
    ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'], ['https://www.googletagmanager.com/gtag/js'],
    ['https://www.google-analytics.com/g/collect', 'fetch'], ['https://fundingchoicesmessages.google.com/i/pub'],
    ['https://ep2.adtrafficquality.google/sodar/sodar2.js'], ['https://mc.yandex.ru/metrika/tag.js'], ['http://doubleclick.net/x']]) {
    assert.equal(unreadByLookup(request(url, type)), true, url);
  }
  for (const [url, type, navigation] of [[api, 'fetch'], ['https://static.17track.net/app.js'], ['https://static.17track.net/app.css', 'stylesheet'],
    ['https://postal.ninja/widget/tracker', 'document', true], ['https://cdn.jsdelivr.net/npm/vue.js'],
    ['https://challenges.cloudflare.com/turnstile/v0/api.js'], ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/pat/1', 'image'],
    ['https://postal.ninja/cdn-cgi/challenge-platform/h/b/img/1', 'image'], ['https://t.17track.net/cdn-cgi/rum', 'font'],
    ['https://www.googletagmanager.com/ns.html', 'document', true], ['https://notdoubleclick.net/x.js'],
    ['https://doubleclick.net.example.test/x.js'], ['https://www.google.com/recaptcha/api.js'],
    ['data:image/png;base64,AAAA', 'image'], ['blob:https://t.17track.net/1', 'image'], ['not a url', 'image']]) {
    assert.equal(unreadByLookup(request(url, type, navigation)), false, url);
  }
});

test('17TRACK and Postal Ninja pages drop what no lookup reads and pass the rest on; other pages are not routed', async () => {
  for (const [url, endpoint, additional] of [[undefined, undefined, undefined], [ninjaUrl, ninjaGet, [ninjaCheck]]]) {
    const { routes } = await fixture(url, endpoint, additional);
    assert.equal(routes.length, 1);
    assert.equal(routes[0][0], '**/*');
    const outcome = async (address, type) => {
      const calls = [];
      await routes[0][1]({ request: () => ({ url: () => address, resourceType: () => type, isNavigationRequest: () => false }),
        abort: reason => { calls.push(['abort', reason]); }, fallback: () => { calls.push(['fallback']); },
        continue: () => { calls.push(['continue']); } });
      return calls;
    };
    assert.deepEqual(await outcome('https://www.googletagmanager.com/gtag/js', 'script'), [['abort', 'blockedbyclient']]);
    assert.deepEqual(await outcome('https://static.17track.net/logo.svg', 'image'), [['abort', 'blockedbyclient']]);
    // TRAWL's outbound policy still decides what passes here.
    assert.deepEqual(await outcome('https://static.17track.net/app.js', 'script'), [['fallback']]);
    assert.deepEqual(await outcome('https://challenges.cloudflare.com/turnstile/v0/api.js', 'script'), [['fallback']]);
  }
  assert.equal((await fixture(upsUrl, upsApi)).routes.length, 0);
  assert.equal((await fixture(fedexUrl, fedexApi)).routes.length, 0);
});

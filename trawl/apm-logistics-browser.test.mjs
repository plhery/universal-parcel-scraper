import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APM_LOGISTICS_ORIGIN, apmLogisticsPageUrl, apmLogisticsTraceUrl, apmLogisticsBrowserNumber, boundApmLogisticsTrace,
  apmLogisticsPayload, projectApmLogisticsReply, runApmLogisticsBrowser } from './apm-logistics-browser.mjs';

const number = '0000000001', url = apmLogisticsPageUrl(number), trace = apmLogisticsTraceUrl();
const capture = { captureResponses: [trace] }, frame = {};
const payload = { success: true, success_detail: { code_customer: 'PRIVATE', shr_name: 'PRIVATE', shp_rates: 1 }, messages: 'Shipment ditemukan',
  volumetric: [],
  shipment: { awb: number, reff: 'PRIVATE', branch: 'APM LOGISTICS MEDAN', shr_phone: 'PRIVATE', origin: 'PRIVATE', origin_hub: 'MES',
    dest: 'PRIVATE', dest_hub: 'JKTM1', user: 'PRIVATE', payment_rates: 'PRIVATE' },
  shipper: { name: 'PRIVATE', address: 'PRIVATE' }, consignee: { name: 'PRIVATE', address: 'PRIVATE' },
  checkpoint: [
    { datetime: '2026-01-13 17:09:26', awb_number: number, code_checkpoint: 'PAKET DITERIMA CABANG', consolidate_number: 'PRIVATE',
      origin_citycode: 'KAB. DELI SERDANG', origin_branch: 'APM LOGISTICS MEDAN', dest_pic: 'PRIVATE', vehicle_courier: 'PRIVATE',
      userstamp: 'PRIVATE', delivery_note: 'PRIVATE' },
    { datetime: '2026-01-13 17:10:25', awb_number: number, code_checkpoint: 'PAKET DITERIMA VENDOR', origin_citycode: 'KAB. DELI SERDANG',
      origin_branch: 'APM LOGISTICS MEDAN', vendor_name: 'PRIVATE' },
  ],
  delivery: { status: '-', name: 'PRIVATE', date: '-', time: '-', val_image: 'PRIVATE', relation: 'PRIVATE', user: 'PRIVATE' },
  origin: { Kecamatan: 'PRIVATE', 'Kota / Kabupaten': 'KAB. DELI SERDANG', Provinsi: 'SUMATERA UTARA', Hub: 'MES' },
  destination: { Kecamatan: 'PRIVATE', 'Kota / Kabupaten': 'KOTA JAKARTA TIMUR', Provinsi: 'DKI JAKARTA', Hub: 'JKTM1' } };
// The tracker sends its JSON as a JSON string.
const wire = data => JSON.stringify(JSON.stringify(data));
const lookup = (extra = {}) => ({ method: () => 'POST', url: () => trace, postData: () => `awb=${number}&token=PRIVATE`, frame: () => frame, ...extra });

function fixture({ body = wire(payload), status = 200, timeout = 1000, respond: answer = true, answers = [{ status, body }] } = {}) {
  const handlers = {}, state = { closed: 0, policy: 0, aborted: 0, fallback: 0, loads: 0 };
  let route;
  const respond = (request, s, headers, text = '') => handlers.response?.({ request: () => request, status: () => s, headers: () => headers,
    body: async () => Buffer.from(text) });
  // Each load of the page posts the waybill once, with the next answer.
  const load = () => {
    const n = state.loads++, next = answers[n];
    if (answer && next) setTimeout(async () => {
      const other = lookup({ postData: () => 'awb=0000000002&token=PRIVATE' });
      if (!n) await route({ request: () => other, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
      const post = lookup();
      await route({ request: () => post, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
      if (!n) respond(other, 200, { 'content-type': 'application/json' }, wire({ ...payload, shipment: { awb: '0000000002' } }));
      respond(post, next.status, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'PRIVATE' }, next.body);
    }, 2);
    return { status: () => 200 };
  };
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    route: async (re, f) => { assert.ok(re.test(trace)); assert.ok(re.test(`${APM_LOGISTICS_ORIGIN}/api/proxy.php?ep=tarif`));
      assert.equal(re.test(`${APM_LOGISTICS_ORIGIN}/js/apm-cekresi.js`), false); route = f; },
    goto: async () => load(), reload: async () => load(),
    url: () => url, bringToFront: async () => {},
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => {} };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, installPolicy: async () => { state.policy++; } }, state, handlers };
}

test('takes only the tracker page for one whole waybill with its own lookup capture', () => {
  assert.equal(url, 'https://apmlogistics.id/cek-resi?resi=0000000001');
  assert.equal(apmLogisticsBrowserNumber(url, capture), number);
  for (const u of [url.replace('https:', 'http:'), `${url}&x=1`, `${url}&resi=0000000002`, url.replace('/cek-resi?', '/cek-resi/?'),
    url.replace('apmlogistics.id', 'example.test'), `${APM_LOGISTICS_ORIGIN}/cek-resi`, apmLogisticsPageUrl('000 0001'), apmLogisticsPageUrl('00001')]) {
    assert.equal(apmLogisticsBrowserNumber(u, capture), null, u);
  }
  assert.equal(apmLogisticsBrowserNumber(url, { captureResponses: [`${trace}&x=1`] }), null);
  assert.equal(apmLogisticsBrowserNumber(url, { captureResponses: [trace, trace] }), null);
});

test('binds the lookup to the whole waybill', () => {
  const page = { mainFrame: () => frame };
  assert.equal(boundApmLogisticsTrace(lookup(), number, page), true);
  assert.equal(boundApmLogisticsTrace(lookup({ postData: () => `token=PRIVATE&awb=${number}` }), number, page), true);
  for (const r of [lookup({ method: () => 'GET' }), lookup({ postData: () => `awb=${number}0&token=x` }),
    lookup({ postData: () => `awb=${number}&awb=${number}&token=x` }), lookup({ postData: () => null }),
    lookup({ url: () => `${APM_LOGISTICS_ORIGIN}/api/proxy.php?ep=tarif` }), lookup({ url: () => `${trace}&ep=trace` }),
    lookup({ url: () => trace.replace('apmlogistics.id', 'example.test') }), lookup({ frame: () => ({}) })]) {
    assert.equal(boundApmLogisticsTrace(r, number, page), false);
  }
});

test('reads the reply sent as a JSON string, and passes on tracking fields only', () => {
  assert.deepEqual(apmLogisticsPayload(wire(payload)), payload);
  assert.deepEqual(apmLogisticsPayload(JSON.stringify(payload)), payload);
  const x = JSON.parse(projectApmLogisticsReply(payload));
  assert.equal(JSON.stringify(x).includes('PRIVATE'), false);
  assert.deepEqual(x.shipment, { awb: number, origin_hub: 'MES', dest_hub: 'JKTM1' });
  assert.deepEqual(x.destination, { city: 'KOTA JAKARTA TIMUR' });
  assert.deepEqual(x.checkpoint[0], { datetime: '2026-01-13 17:09:26', awb_number: number, code_checkpoint: 'PAKET DITERIMA CABANG',
    origin_citycode: 'KAB. DELI SERDANG', origin_branch: 'APM LOGISTICS MEDAN' });
  assert.deepEqual(x.delivery, { status: '-', date: '-', time: '-' });
  for (const y of [null, [], 'x']) assert.equal(projectApmLogisticsReply(y), 'null');
  assert.deepEqual(JSON.parse(projectApmLogisticsReply({ success: false, messages: 'Shipment tidak ditemukan' })),
    { success: false, messages: 'Shipment tidak ditemukan' });
  assert.equal(JSON.parse(projectApmLogisticsReply({ success: true, checkpoint: {} })).checkpoint, null);
});

test('captures the page’s own lookup and stops other waybills', async () => {
  const f = fixture(); const r = await runApmLogisticsBrowser(f.options);
  assert.equal(r.reason, 'apm-logistics-reply'); assert.equal(f.state.aborted, 1); assert.equal(f.state.fallback, 1);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(r.capturedResponses[0].url, trace);
  assert.equal(JSON.parse(r.capturedResponses[0].body).checkpoint.length, 2);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.state.policy, 1);
  assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('keeps the tracker’s answer for an unknown waybill and marks a page that is not JSON', async () => {
  const unknown = await runApmLogisticsBrowser(fixture({ body: wire({ success: false, messages: 'Shipment tidak ditemukan' }) }).options);
  assert.deepEqual(JSON.parse(unknown.capturedResponses[0].body), { success: false, messages: 'Shipment tidak ditemukan' });
  const html = await runApmLogisticsBrowser(fixture({ body: '<html>PRIVATE</html>' }).options);
  assert.equal(html.capturedResponses[0].error, 'invalid-json'); assert.equal(JSON.stringify(html).includes('PRIVATE'), false);
  const blocked = await runApmLogisticsBrowser(fixture({ status: 403, body: 'PRIVATE' }).options);
  assert.equal(blocked.capturedResponses[0].status, 403); assert.equal(blocked.capturedResponses[0].body, '');
});

test('reloads the page once for a new token when reCAPTCHA refuses the first', async () => {
  const refused = { status: 200, body: wire({ success: false, messages: 'Google Captcha Error' }) };
  const once = fixture({ timeout: 20000, answers: [refused, { status: 200, body: wire(payload) }] });
  const r = await runApmLogisticsBrowser(once.options);
  assert.equal(once.state.loads, 2); assert.equal(r.capturedResponses.length, 2);
  assert.equal(r.capturedResponses[0].error, 'recaptcha-refused'); assert.equal(r.capturedResponses[0].body, '');
  assert.equal(r.capturedResponses[1].status, 200); assert.equal(JSON.parse(r.capturedResponses[1].body).shipment.awb, number);
  const twice = fixture({ timeout: 20000, answers: [refused, refused, refused] });
  const t = await runApmLogisticsBrowser(twice.options);
  assert.equal(twice.state.loads, 2); assert.deepEqual(t.capturedResponses.map(x => x.error), ['recaptcha-refused', 'recaptcha-refused']);
  const late = fixture({ answers: [refused, refused] });
  assert.equal((await runApmLogisticsBrowser(late.options)).capturedResponses.length, 1); assert.equal(late.state.loads, 1);
});

test('reports a lookup that never came', async () => {
  const f = fixture({ respond: false, timeout: 300 }); const r = await runApmLogisticsBrowser(f.options);
  assert.equal(r.reason, 'apm-logistics-capture_missing'); assert.equal(r.capturedResponses.length, 0); assert.equal(f.state.closed, 1);
});

test('leaves other pages to the generic tiers', async () => {
  assert.equal(await runApmLogisticsBrowser({ ...fixture().options, url: `${APM_LOGISTICS_ORIGIN}/cek-resi` }), undefined);
});

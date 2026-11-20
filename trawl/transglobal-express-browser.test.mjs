import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSGLOBAL_PAGE, TRANSGLOBAL_RESULT, transglobalPageUrl, transglobalBrowserNumber, boundTransglobalPost,
  transglobalRedirectMatches, transglobalFormAnswer, transglobalHistory, runTransglobalBrowser } from './transglobal-express-browser.mjs';

// A synthetic reference and page, shaped like the form's result page.
const reference = 'TP-100000009', url = transglobalPageUrl(reference);
const capture = { captureResponses: [TRANSGLOBAL_RESULT] }, frame = {};
const location = `${TRANSGLOBAL_RESULT}?orderID=100000009&deliveryPostcode=PRIVATE`;
const resultPage = `<html><head><title>Track</title><script>var PRIVATE = 1</script></head><body>
<header>PRIVATE</header>
<main>
  <div id="tracking_journey">
    <div class="external_tracking"><span class="leg">Evri (Main)</span><span class="reference">Ref <strong>ZZ000000000000001</strong></span>
      <a href="https://example.test/PRIVATE">Track</a></div>
    <div class="external_tracking"><span class="note">PRIVATE</span></div>
  </div>
  <div class="scans"><img src="https://example.test/PRIVATE.png"></div>
  <div class="tracking_data">
    <div class="status_update">
      <div class="uspsHeader"><span class="time_stamp">Monday, January 5, 2026</span></div>
      <div class="uspsTrackItem"><span class="time_stamp">10:15</span><span class="description">Parcel processed at the hub</span>
        <span class="location">Hub</span><span style="display:none">PRIVATE</span></div>
      <div class="uspsTrackItem"><span class="time_stamp">08:00</span><span class="description">Booking made</span>
        <span class="location">Awaiting Collection</span></div>
    </div>
  </div>
  <form><input name="PRIVATE" value="PRIVATE"></form>
</main></body></html>`;
const formPage = '<html><body><main><div class="ErrorNotification">Order not found</div><form></form></main></body></html>';

const post = (body = `Reference=${encodeURIComponent(reference)}&SubmitTracking=Track`, extra = {}) => ({
  method: () => 'POST', url: () => TRANSGLOBAL_PAGE, postData: () => body, frame: () => frame,
  headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }), ...extra });

function fixture({ status = 200, redirect = location, body = resultPage, postStatus = 302, postBody = '', timeout = 1000,
  verification = 'ok', submit = true, respond: answer = true } = {}) {
  const handlers = {}, state = { closed: 0, policy: 0, aborted: 0, fallback: 0, filled: null, waited: 0 };
  let route;
  const respond = (request, s, headers, text = '', address = TRANSGLOBAL_PAGE) => handlers.response?.({ request: () => request,
    status: () => s, headers: () => headers, url: () => address, body: async () => Buffer.from(text) });
  const page = { mainFrame: () => frame, on: (e, f) => { handlers[e] = f; }, off: e => { delete handlers[e]; },
    route: async (match, f) => {
      assert.equal(match(new URL(TRANSGLOBAL_PAGE)), true);
      assert.equal(match(new URL(`${TRANSGLOBAL_PAGE}?reference=x`)), false);
      assert.equal(match(new URL(TRANSGLOBAL_RESULT)), false);
      route = f;
    },
    goto: async () => ({ status: () => 200 }),
    locator: () => ({ waitFor: async () => {}, fill: async value => { state.filled = value; } }),
    evaluate: async () => {
      if (!submit) return false;
      if (answer) setTimeout(async () => {
        const other = post('Reference=TP-100000017&SubmitTracking=Track');
        await route({ request: () => other, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
        const get = { method: () => 'GET' };
        await route({ request: () => get, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
        const mine = post();
        await route({ request: () => mine, fallback: async () => { state.fallback++; }, abort: async () => { state.aborted++; } });
        if (postStatus !== 302) { respond(mine, postStatus, { 'content-type': 'text/html' }, postBody); return; }
        respond(mine, 302, { location: redirect });
        const follow = { method: () => 'GET', redirectedFrom: () => mine };
        respond(follow, status, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'PRIVATE' }, body, redirect);
      }, 2);
      return true;
    },
    waitForTimeout: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  const handle = { browser: { newContext: async () => context }, requestBrowserReplacement: () => {} };
  const waitCloudflare = async (p, ms, address) => { state.waited++; assert.equal(address, TRANSGLOBAL_PAGE); assert.ok(ms > 0); return verification; };
  return { options: { url, capture, handle, tier: 3, maxTimeout: timeout, waitCloudflare,
    installPolicy: async () => { state.policy++; } }, state, handlers };
}

test('takes only the form for one whole reference with its own result capture', () => {
  assert.equal(url, `${TRANSGLOBAL_PAGE}?reference=${reference}`);
  assert.equal(transglobalBrowserNumber(url, capture), reference);
  for (const u of [url.replace('https:', 'http:'), `${url}&x=1`, `${url}&reference=${reference}`, url.replace('www.', ''),
    TRANSGLOBAL_PAGE, transglobalPageUrl('TP100000009'), transglobalPageUrl('TP-012345678'), transglobalPageUrl('tp-100000009'),
    transglobalPageUrl('TP-1000000000'), `${TRANSGLOBAL_RESULT}?reference=${reference}`]) {
    assert.equal(transglobalBrowserNumber(u, capture), null, u);
  }
  assert.equal(transglobalBrowserNumber(url, {}), null);
  assert.equal(transglobalBrowserNumber(url, { captureResponses: [TRANSGLOBAL_RESULT, TRANSGLOBAL_RESULT] }), null);
  assert.equal(transglobalBrowserNumber(url, { captureResponses: [TRANSGLOBAL_PAGE] }), null);
});

test('binds the post to the whole reference', () => {
  const page = { mainFrame: () => frame };
  assert.equal(boundTransglobalPost(post(), reference, page), true);
  assert.equal(boundTransglobalPost(post(`Reference=${reference}`), reference, page), true);
  for (const r of [post(undefined, { method: () => 'GET' }), post(`Reference=${reference}0`), post(`Reference=${reference}&Reference=${reference}`),
    post(`Reference=${reference}&x=1`), post(''), post(undefined, { postData: () => null }), post(undefined, { headers: () => ({}) }),
    post(undefined, { url: () => `${TRANSGLOBAL_PAGE}?x=1` }), post(undefined, { frame: () => ({}) })]) {
    assert.equal(boundTransglobalPost(r, reference, page), false);
  }
});

test('follows only a redirect to this order’s result page', () => {
  assert.equal(transglobalRedirectMatches(location, reference), true);
  assert.equal(transglobalRedirectMatches('/Tracking/TrackShipmentNEW/?orderID=100000009', reference), true);
  for (const l of ['', `${TRANSGLOBAL_RESULT}?orderID=100000017`, `${TRANSGLOBAL_RESULT}?orderID=100000009&orderID=100000009`,
    `${TRANSGLOBAL_RESULT}?orderID=100000009&x=1`, `${TRANSGLOBAL_RESULT}?orderID=100000009#x`, `${TRANSGLOBAL_PAGE}?orderID=100000009`,
    'https://example.test/Tracking/TrackShipmentNEW/?orderID=100000009', 'https://a:b@www.transglobalexpress.co.uk/Tracking/TrackShipmentNEW/?orderID=100000009']) {
    assert.equal(transglobalRedirectMatches(l, reference), false, l);
  }
});

test('reads the form’s own not-found notice and nothing else', () => {
  assert.deepEqual(transglobalFormAnswer(formPage), { kind: 'not_found' });
  assert.deepEqual(transglobalFormAnswer(formPage.replace('Order not found', 'Something went wrong')), { kind: 'unconfirmed' });
  assert.deepEqual(transglobalFormAnswer(formPage.replace('<main>', '<main><div class="ErrorNotification">x</div>')), { kind: 'unconfirmed' });
  assert.deepEqual(transglobalFormAnswer('<html><head><title>Just a moment...</title></head></html>'), { kind: 'challenge' });
  assert.deepEqual(transglobalFormAnswer('x'.repeat(1_000_001)), { kind: 'schema' });
});

test('passes on the legs and dated rows alone', () => {
  const answer = transglobalHistory(resultPage);
  assert.equal(JSON.stringify(answer).includes('PRIVATE'), false);
  assert.deepEqual(answer, { kind: 'history', legs: [{ name: 'Evri (Main)', number: 'ZZ000000000000001' }], days: [{ date: 'Monday, January 5, 2026',
    rows: [{ time: '10:15', description: 'Parcel processed at the hub', location: 'Hub' },
      { time: '08:00', description: 'Booking made', location: 'Awaiting Collection' }] }] });
  assert.deepEqual(transglobalHistory(resultPage.replace('class="tracking_data"', 'class="other"')), { kind: 'unconfirmed' });
  assert.deepEqual(transglobalHistory('<html><title>Attention Required</title></html>'), { kind: 'challenge' });
  assert.deepEqual(transglobalHistory(resultPage.replace('Monday, January 5, 2026', 'x'.repeat(41))), { kind: 'schema' });
});

test('posts the reference once, follows its redirect and keeps no postcode', async () => {
  const f = fixture(); const r = await runTransglobalBrowser(f.options);
  assert.equal(r.reason, 'transglobal-reply'); assert.equal(r.effectiveUrl, url);
  assert.equal(f.state.filled, reference); assert.equal(f.state.aborted, 1); assert.equal(f.state.fallback, 2);
  assert.equal(r.capturedResponses.length, 1);
  const [row] = r.capturedResponses;
  assert.equal(row.url, TRANSGLOBAL_RESULT); assert.equal(row.status, 200); assert.equal(row.trackingNumberSubmitted, 'TP100000009');
  assert.deepEqual(row.headers, { 'content-type': 'text/html; charset=utf-8' });
  assert.equal(JSON.parse(row.body).kind, 'history');
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false);
  assert.equal(f.state.policy, 1); assert.equal(f.state.closed, 1); assert.deepEqual(f.handlers, {});
});

test('reads the form’s answer to a reference it does not know', async () => {
  const r = await runTransglobalBrowser(fixture({ postStatus: 200, postBody: formPage }).options);
  assert.equal(r.capturedResponses.length, 1); assert.deepEqual(JSON.parse(r.capturedResponses[0].body), { kind: 'not_found' });
});

test('keeps a redirect to another order as one, without its address', async () => {
  const other = `${TRANSGLOBAL_RESULT}?orderID=100000017&deliveryPostcode=PRIVATE`;
  const r = await runTransglobalBrowser(fixture({ redirect: other }).options);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].error, 'unexpected-redirect');
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false);
});

test('keeps a refused post and a challenged result in their place', async () => {
  const refused = await runTransglobalBrowser(fixture({ postStatus: 403, postBody: '<title>Just a moment...</title>' }).options);
  assert.equal(refused.capturedResponses[0].status, 403); assert.equal(refused.capturedResponses[0].body, '');
  const page = await runTransglobalBrowser(fixture({ body: '<html><title>Just a moment...</title></html>' }).options);
  assert.equal(page.capturedResponses[0].error, 'challenge-html');
});

test('reports a verification that never cleared and a post that never came', async () => {
  const blocked = fixture({ verification: 'timeout' }); const r = await runTransglobalBrowser(blocked.options);
  assert.equal(r.reason, 'transglobal-verification'); assert.equal(r.capturedResponses.length, 0); assert.equal(blocked.state.filled, null);
  const silent = fixture({ respond: false, timeout: 300 }); const s = await runTransglobalBrowser(silent.options);
  assert.equal(s.reason, 'transglobal-capture_missing'); assert.equal(silent.state.closed, 1);
  assert.equal((await runTransglobalBrowser(fixture({ submit: false }).options)).reason, 'transglobal-form');
});

test('leaves other pages to the generic tiers and needs its Cloudflare wait', async () => {
  assert.equal(await runTransglobalBrowser({ ...fixture().options, url: TRANSGLOBAL_PAGE }), undefined);
  assert.equal((await runTransglobalBrowser({ ...fixture().options, waitCloudflare: undefined })).reason, 'transglobal-runtime');
});

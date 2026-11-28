import test from 'node:test';
import assert from 'node:assert/strict';
import { pasarexBrowserNumber, pasarexHistory, pasarexRequestMatches, runPasarexBrowser, PASAREX_PAGE as PAGE, PASAREX_RESULT as RESULT } from './pasarex-browser.mjs';

// Synthetic markup in the tracker's shape, with invented values.
const number = 'PSRTEST000001', url = PAGE + '?awb=' + number, capture = { captureResponses: [RESULT] };
const group = (status, rows) => `<div><div class="d-flex align-items-center"><img alt=""><p class="m-0 ml-4">${status}</p></div><div class="table-timeline"><table><caption style="display: none">Estados de tracking</caption><thead><tr><th><p>Description</p></th><th><p>City</p></th><th><p>Date</p></th><th><p>Hour</p></th></tr></thead><tbody>${
  rows.map(([d, c, day, hour]) => `<tr><td><p>${d}</p></td><td><p>${c}</p></td><td><p>${day}</p></td><td><p>${hour}</p></td></tr>`).join('')}</tbody></table></div></div>`;
const html = `<html><body><form action="${RESULT}"><input name="awb" value="PRIVATE"><textarea name="g-recaptcha-response">PRIVATE</textarea></form>
<div class="card-fond-blue"><p><img alt="">AWB Number ${number}</p></div><div class="card-delivered"><p>Shipment delivered in perfect condition</p><p>13/08/2026</p></div>
<div class="timeline">${group('DELIVERED', [['Shipment delivered in perfect condition', 'Sampletown', '13/08/2026', '15:31:03']])}${
  group('IN CUSTOMS PROCESS', [['Entry to station for customs processing.', 'Sampletown', '10/08/2026', '09:47:46'], ['Cleared by customs by PasarEx.', '', '10/08/2026', '09:47:44']])}</div></body></html>`;
const target = (value = number, token = 'PRIVATE', extra = '') => `${RESULT}?old_awb=${value}&awb=${value}&g-recaptcha-response=${token}${extra}`;
const request = (page, address = target(), extra = {}) => ({ url: () => address, method: () => 'GET', frame: () => page.mainFrame(), ...extra });

function fixture({ status = 200, data = html, token = true, delay = 0, cooldown = 0, abort = null, pictures = token } = {}) {
  const state = { closed: 0, native: 0, checkbox: 0, images: 0, filled: null, sent: 0, aborted: 0, observerBeforeNavigation: false, opened: null }; const frame = {};
  let responseHandler, routeHandler;
  const page = { route: async (_, fn) => { routeHandler = fn; }, mainFrame: () => frame, on: (event, fn) => { if (event === 'response') responseHandler = fn; }, off: () => {},
    goto: async address => { state.opened = address; state.observerBeforeNavigation = !!responseHandler; return { status: () => 200 }; },
    waitForFunction: async () => {}, frameLocator: () => ({ first: () => ({ locator: () => ({ click: async () => { state.checkbox++; } }) }) }),
    locator: selector => ({ fill: async value => { state.filled = value; }, inputValue: async () => token ? 'PRIVATE' : '', click: async () => {
      assert.equal(selector, 'form button[type="submit"]'); const sent = request(page, target(state.filled));
      await routeHandler({ request: () => sent, abort: async () => { state.aborted++; }, fallback: async () => { state.sent++; } });
      if (state.aborted) return;
      responseHandler({ request: () => sent, url: () => sent.url(), status: () => status, headers: () => ({ 'content-type': 'text/html' }),
        body: async () => { if (delay) await new Promise(r => setTimeout(r, delay)); return Buffer.from(data); } });
    } }) };
  const context = { newPage: async () => page, close: async () => { state.closed++; } };
  return { state, page, options: { url, capture, handle: { browser: { newContext: async () => context } }, tier: 3, maxTimeout: 1000,
    signal: abort, audioBackoff: { remainingMs: async () => cooldown, block: () => {} }, solveNativeCaptcha: async () => { state.native++; },
    solveImages: async (_, { timeoutMs }) => { state.images++; assert(timeoutMs >= 1); return pictures; }, reportImages: () => {} } };
}

test('takes only the tracking page with the whole number and the result capture', () => {
  assert.equal(pasarexBrowserNumber(url, capture), number);
  for (const u of [url + '&x=1', url + '&awb=' + number, url + '#x', url.replace('https://', 'https://user@'), url.replace('/?', '/tracking?'), url.replace(number, 'short')]) assert.equal(pasarexBrowserNumber(u, capture), null);
  assert.equal(pasarexBrowserNumber(url, { captureResponses: [PAGE] }), null);
});

test('reads the number and each status group\'s rows, without the form or its token', () => {
  const result = pasarexHistory(html, number);
  assert.equal(result.kind, 'history'); assert.equal(result.number, number);
  assert.deepEqual(result.groups.map(g => [g.status, g.rows.length]), [['DELIVERED', 1], ['IN CUSTOMS PROCESS', 2]]);
  assert.deepEqual(result.groups[1].rows[1], { description: 'Cleared by customs by PasarEx.', city: '', date: '10/08/2026', hour: '09:47:44' });
  assert(!JSON.stringify(result).includes('PRIVATE'));
  assert.deepEqual(pasarexHistory(html, number + '1'), { kind: 'identity_mismatch' });
  assert.deepEqual(pasarexHistory(html.replace('<div class="timeline">', `<p>AWB Number ${number}</p><div class="timeline">`), number), { kind: 'schema' });
  assert.equal(pasarexHistory(html.replace('<p>Hour</p>', '<p>Time</p>'), number).groups[0], null);
});

test('reads the tracker\'s notice as not found and anything else as unconfirmed', () => {
  assert.deepEqual(pasarexHistory('<html><body><h3>¡ERROR!</h3><p>Guía no encontrada</p></body></html>', number), { kind: 'not_found' });
  assert.deepEqual(pasarexHistory('<html><body>Error temporal</body></html>', number), { kind: 'unconfirmed' });
  assert.deepEqual(pasarexHistory('<html><body>Please verify you are not a robot</body></html>', number), { kind: 'challenge' });
  assert.deepEqual(pasarexHistory('<html><body><div hidden>Guía no encontrada</div></body></html>', number), { kind: 'unconfirmed' });
});

test('binds the form\'s main-frame GET with the whole number and one token', () => {
  const f = fixture(); assert(pasarexRequestMatches(request(f.page), f.page, number));
  for (const r of [request(f.page, target(number.slice(0, -1))), request(f.page, target(), { method: () => 'POST' }), request(f.page, target(), { frame: () => ({}) }),
    request(f.page, target(number, '')), request(f.page, target(number, 'PRIVATE', '&awb=' + number)), request(f.page, target(number, 'PRIVATE', '&x=1')),
    request(f.page, `${RESULT}?old_awb=OTHER1&awb=${number}&g-recaptcha-response=PRIVATE`)]) assert(!pasarexRequestMatches(r, f.page, number));
});

test('captures the bound result page after delayed decoding, without the token or cookies', async () => {
  const f = fixture({ delay: 10 }); const r = await runPasarexBrowser(f.options);
  assert(f.state.observerBeforeNavigation); assert.equal(f.state.opened, url); assert.equal(f.state.filled, number); assert.equal(f.state.sent, 1); assert.equal(f.state.closed, 1);
  assert.equal(r.capturedResponses.length, 1); assert.equal(r.capturedResponses[0].url, RESULT);
  assert.deepEqual(JSON.parse(r.capturedResponses[0].body), pasarexHistory(html, number)); assert.equal(r.html, ''); assert.deepEqual(r.cookies, []);
  assert(!JSON.stringify(r).includes('PRIVATE'));
});

test('keeps status refusals separate from history', async () => {
  for (const status of [403, 429, 503]) { const f = fixture({ status }); const r = await runPasarexBrowser(f.options); assert.equal(r.capturedResponses.at(-1).status, status); assert.equal(r.capturedResponses.at(-1).body, null); assert.equal(f.state.closed, 1); }
});

test('gives the pictures the audio solver\'s time while audio waits out its pause', async () => {
  const budgets = [];
  for (const cooldown of [0, 60_000]) {
    const f = fixture({ cooldown });
    await runPasarexBrowser({ ...f.options, maxTimeout: 60_000, solveImages: async (_, { timeoutMs }) => { budgets.push(timeoutMs); return true; } });
  }
  assert(budgets[0] <= 35_000, String(budgets[0])); assert(budgets[1] > 45_000, String(budgets[1]));
});

test('ticks the checkbox and answers its pictures, leaving audio as the last resort within its pause', async () => {
  const f = fixture(); await runPasarexBrowser(f.options);
  assert.equal(f.state.checkbox, 1); assert.equal(f.state.images, 1); assert.equal(f.state.native, 0); assert.equal(f.state.sent, 1);
  const g = fixture({ token: false, cooldown: 1000 }); g.options.maxTimeout = 60_000; const r = await runPasarexBrowser(g.options);
  assert.equal(g.state.images, 1); assert.equal(g.state.native, 0); assert.equal(g.state.sent, 0); assert.equal(r.capturedResponses.length, 0); assert.equal(g.state.closed, 1);
  const h = fixture({ token: false }); h.options.maxTimeout = 60_000; await runPasarexBrowser(h.options);
  assert.equal(h.state.images, 1); assert.equal(h.state.native, 1); assert.equal(h.state.sent, 0);
  const i = fixture({ token: false }); await runPasarexBrowser(i.options);
  assert.equal(i.state.native, 0, 'audio needs time the lookup no longer has');
});

test('deadline and cancellation close the context and discard unfinished bodies', async () => {
  const f = fixture({ delay: 100 }); f.options.maxTimeout = 30; const r = await runPasarexBrowser(f.options); assert.equal(f.state.closed, 1); assert.equal(r.capturedResponses.at(-1)?.body ?? null, null);
  const c = new AbortController(); c.abort(); const g = fixture({ abort: c.signal }); await runPasarexBrowser(g.options); assert.equal(g.state.sent, 0);
});

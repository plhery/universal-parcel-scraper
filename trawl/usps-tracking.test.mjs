import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachUspsTrackingCapture, forgetUspsOutageSessions, uspsCaptureNumber, uspsOutage } from './usps-tracking.mjs';

const NUMBER = '9400111899223397910421';
const URL = `https://tools.usps.com/tracking/${NUMBER}`;
const OUTAGE = 'https://www.usps.com/root/global/server_responses/anyapp_outage_apology.htm';
const OPTIONS = { contentWaitForSelector: '#trackingNum', captureResponses: [URL] };
function harness() {
  const page = new EventEmitter();
  const frame = {};
  let ready;
  const waits = [];
  page.mainFrame = () => frame;
  page.waitForSelector = (selector, options) => {
    waits.push({ selector, ...options });
    return new Promise(resolve => { ready = resolve; });
  };
  const capture = attachUspsTrackingCapture(page, URL, OPTIONS);
  const respond = (overrides = {}) => page.emit('response', {
    url: () => overrides.url ?? URL, status: () => overrides.status ?? 302,
    headers: () => ({ location: overrides.location ?? OUTAGE, 'set-cookie': 'discard', other: 'discard' }),
    request: () => ({ method: () => overrides.method ?? 'GET', resourceType: () => overrides.type ?? 'xhr',
      frame: () => overrides.frame ?? frame }),
  });
  return { page, capture, respond, waits, ready: () => ready?.() };
}

test('only the opted-in exact USPS tracking capture is handled', () => {
  assert.equal(uspsCaptureNumber(URL, OPTIONS), NUMBER);
  for (const url of [URL + '?x=1', URL + '#x', URL.replace('https:', 'http:'),
    URL.replace('tools.usps.com', 'tools.usps.com.example'), URL.replace('tools.', 'user@tools.'),
    URL.replace(NUMBER, '1')]) assert.equal(uspsCaptureNumber(url, { ...OPTIONS, captureResponses: [url] }), null);
  for (const options of [{}, { ...OPTIONS, captureResponses: [] }, { ...OPTIONS, captureResponses: [URL, OUTAGE] },
    { ...OPTIONS, contentWaitForSelector: 'body' }]) assert.equal(uspsCaptureNumber(URL, options), null);
});

test('only an exact bound redirect ends readiness, and its safe projection is bounded', async () => {
  const h = harness();
  const waiting = h.capture.prepare(20_000);
  for (const overrides of [{ url: URL + '1' }, { status: 200 }, { method: 'POST' }, { type: 'image' },
    { frame: {} }, { location: OUTAGE + '?token=secret' }, { location: OUTAGE.replace('www.usps.com', 'example.com') }]) {
    h.respond(overrides);
    assert.equal(h.capture.hasResponse(), false);
  }
  h.respond();
  await waiting;
  for (let i = 0; i < 10; i++) h.respond();
  const options = h.capture.contentOptions(OPTIONS);
  assert.equal(options.contentWaitForSelector, undefined);
  assert.equal(OPTIONS.contentWaitForSelector, '#trackingNum');
  const result = await h.capture.drain();
  assert.equal(result.capturedResponses.length, 3);
  assert.deepEqual(result.capturedResponses[0], { url: URL, status: 302, headers: { location: OUTAGE },
    body: null, error: null, truncated: false, base64Encoded: false, trackingNumberSubmitted: NUMBER });
  assert.equal(h.page.listenerCount('response'), 0);
});

test('ordinary tracking uses one readiness wait and retains no page or session data', async () => {
  const h = harness();
  const waiting = h.capture.prepare(4000);
  h.respond({ status: 200 });
  h.ready();
  await waiting;
  await h.capture.settle(1000);
  assert.deepEqual(h.waits, [{ selector: '#trackingNum', state: 'visible', timeout: 4000 }]);
  assert.equal(h.capture.hasResponse(), false);
  assert.equal(h.capture.contentOptions(OPTIONS).contentWaitForSelector, undefined);
  assert.deepEqual(await h.capture.drain(), { capturedResponses: [] });
});

test('deadline cleanup stops observation and resolves an outstanding prepare', async () => {
  const h = harness();
  const waiting = h.capture.prepare(60_000);
  assert.equal(h.waits[0].timeout, 10_000);
  await h.capture.drain();
  await waiting;
  h.respond();
  assert.equal(h.capture.hasResponse(), false);
});

test('only the bound tracking request\'s outage redirect marks a reply as sent to the outage page', () => {
  const redirect = { url: URL, status: 302, headers: { location: OUTAGE }, trackingNumberSubmitted: NUMBER };
  assert.equal(uspsOutage({ capturedResponses: [redirect] }), true);
  for (const response of [{ ...redirect, status: 200 }, { ...redirect, headers: { location: OUTAGE + '?x=1' } },
    { ...redirect, trackingNumberSubmitted: undefined }, { ...redirect, trackingNumberSubmitted: '' },
    { ...redirect, url: 'https://example.com/tracking/' + NUMBER }, null]) {
    assert.equal(uspsOutage({ capturedResponses: [response] }), false);
  }
  for (const result of [undefined, {}, { capturedResponses: [] }, { capturedResponses: 'x' }]) assert.equal(uspsOutage(result), false);
});

test('a USPS session sent to the outage page is dropped after a replay and never saved from a fresh browser', () => {
  const source = [
    'import { x } from "./x"',
    '      if (hasUsablePayload(t2) && !crossed2) {',
    '        if (t2.cookies && t2.cookies.length > 0) {',
    '          await deps.saveSession(domain, {})',
    '        }',
    '      }',
    '      if (hasUsablePayload(t3) && !crossed3) {',
    '        const cookies: Cookie[] = t3.cookies ?? []',
    '        if (cookies.length > 0 && !explicitProxy && !importedCookies) {',
    '          await deps.saveSession(domain, {})',
    '        }',
    '      }',
    '      if (hasUsablePayload(t4) && !crossed4) {',
    '      const cookies: Cookie[] = t4.cookies ?? []',
    '      if (cookies.length > 0 && !explicitProxy && !importedCookies) {',
  ].join('\n');
  const patched = forgetUspsOutageSessions(source);
  assert.match(patched, /^import \{ uspsOutage \} from "\.\/utils\/usps-tracking\.mjs"\n/);
  assert.match(patched, /if \(uspsOutage\(t2\)\) await deps\.invalidateSession\(domain\)\n {8}else if \(t2\.cookies/);
  assert.match(patched, /!importedCookies && !uspsOutage\(t3\)\) \{/);
  assert.equal(patched.split('uspsOutage(').length, 3);
  assert.throws(() => forgetUspsOutageSessions(source.replace('t2.cookies &&', 't2.cookies?.length &&')), /review the USPS outage session patch/);
  assert.throws(() => forgetUspsOutageSessions(source + '\n        if (t2.cookies && t2.cookies.length > 0) {'), /review the USPS outage session patch/);
});

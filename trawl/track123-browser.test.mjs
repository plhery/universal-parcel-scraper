import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { track123Data, track123Number, track123Request, runTrack123Browser } from './track123-browser.mjs';

const number = '909876543210';
const pageUrl = 'https://www.track123.com/carriers/fedex';
const query = 'https://www.track123.com/tk/api/v2/anonymous/track/query-track-nos';
const poll = 'https://www.track123.com/tk/api/v2/anonymous/track/polling-waybill';
const url = `${pageUrl}#trawl-number=${number}`;
const capture = { captureResponses: [query, poll] };

test('only a well-formed courier page and the exact capture sequence qualify', () => {
  assert.equal(track123Number(url, capture), number);
  assert.deepEqual(track123Request(`https://www.track123.com/carriers/dhl-germany#trawl-number=JJD0000000000000001`, capture),
    { code: 'dhl-germany', number: 'JJD0000000000000001' });
  for (const other of [url.replace('fedex', 'FedEx'), url.replace('fedex', 'fed%2Fex'), url.replace('fedex', 'fedex/x'),
    url.replace('fedex', `a${'b'.repeat(64)}`), url.replace('/carriers/fedex', '/carriers/'), url.replace('/carriers', '/track'),
    url.replace('www.track123.com', 'other.test'), url.replace('https:', 'http:'), `${url}&other=x`, `${pageUrl}?number=${number}`,
    `${pageUrl}?x=1#trawl-number=${number}`, `${pageUrl}#trawl-number=abc`, `${pageUrl}#trawl-number=ABCDEF`, `${pageUrl}#trawl-number=12`]) {
    assert.equal(track123Number(other, capture), null);
  }
  assert.equal(track123Number(url, { captureResponses: [query] }), null);
});

test('only history fields leave the service', () => {
  const payload = track123Data({ code: '00000', ticket: 'private', msg: 'private', data: { landWaybillLists: [{
    trackingNo: number, localProviderCode: 'fedex', recipient: 'private', querying: false,
    localDetails: [{ trackingNo: number, eventTime: '2026-01-08 10:00:00', recipient: 'private' }],
  }] } });
  assert.ok(!JSON.stringify(payload).includes('private'));
});

test('observes before submission, waits for history and closes its context', async () => {
  const page = new EventEmitter(); let closed = 0, clicks = 0;
  page.goto = async value => { assert.equal(value, pageUrl); return { status: () => 200 }; };
  page.locator = selector => selector.startsWith('textarea') ? { fill: async value => assert.equal(value, number) }
    : { click: async () => {
      clicks++;
      const request = { method: () => 'POST', url: () => query, postDataJSON: () => ({ logisticsCode: 'fedex', trackNos: [number] }) };
      page.emit('request', request);
      page.emit('response', { request: () => request, url: () => query, status: () => 200, headers: () => ({}), body: async () => Buffer.from(JSON.stringify({
        code: '00000', data: { landWaybillLists: [{ trackingNo: number, localProviderCode: 'fedex', querying: false, localDetails: [] }] },
      })) });
    } };
  const context = { newPage: async () => page, close: async () => { closed++; } };
  const result = await runTrack123Browser({ url, capture, maxTimeout: 1500, tier: 3,
    handle: { browser: { newContext: async () => context } } });
  assert.ok(result.html.length > 0); // A capture-only result must survive the orchestrator's payload gate.
  assert.ok(!result.html.includes(number));
  assert.equal(result.capturedResponses.length, 1);
  assert.equal(result.capturedResponses[0].trackingNumberSubmitted, number);
  assert.equal(clicks, 1); assert.equal(closed, 1);
});

test('an unfinished later poll cannot expose an earlier success at the deadline', async () => {
  const page = new EventEmitter(); let closed = 0;
  page.goto = async () => ({ status: () => 200 });
  page.locator = selector => selector.startsWith('textarea') ? { fill: async () => {} }
    : { click: async () => {
      const request = { method: () => 'POST', url: () => query, postDataJSON: () => ({ logisticsCode: 'fedex', trackNos: [number] }) };
      page.emit('request', request);
      page.emit('response', { request: () => request, url: () => query, status: () => 200, headers: () => ({}), body: async () => Buffer.from(JSON.stringify({
        code: '00000', data: { landWaybillLists: [{ trackingNo: number, localProviderCode: 'fedex', querying: false, localDetails: [] }] },
      })) });
      page.emit('request', { method: () => 'POST', url: () => poll, postDataJSON: () => [{ logisticsId: '1', trackingNo: number }] });
    } };
  const context = { newPage: async () => page, close: async () => { closed++; } };
  const result = await runTrack123Browser({ url, capture, maxTimeout: 80, tier: 3,
    handle: { browser: { newContext: async () => context } } });
  assert.equal(result.capturedResponses.at(-1).error, 'track123-request-pending');
  assert.equal(result.capturedResponses.at(-1).status, 0);
  assert.equal(closed, 1);
});

test('a query for another courier or number, or a poll for several numbers, is not captured', async () => {
  for (const [target, body] of [[query, { logisticsCode: 'ups', trackNos: [number] }], [query, { logisticsCode: 'fedex', trackNos: [number, '909876543211'] }],
    [poll, [{ logisticsId: '1', trackingNo: number }, { logisticsId: '1', trackingNo: '909876543211' }]]]) {
    const page = new EventEmitter();
    page.goto = async () => ({ status: () => 200 });
    page.locator = selector => selector.startsWith('textarea') ? { fill: async () => {} } : { click: async () => {
      const request = { method: () => 'POST', url: () => target, postDataJSON: () => body };
      page.emit('request', request);
      page.emit('response', { request: () => request, url: () => target, status: () => 200, headers: () => ({}), body: async () => Buffer.from(JSON.stringify({
        code: '00000', data: { landWaybillLists: [{ trackingNo: number, localProviderCode: 'fedex', querying: false, localDetails: [] }] },
      })) });
    } };
    const result = await runTrack123Browser({ url, capture, maxTimeout: 80, tier: 3,
      handle: { browser: { newContext: async () => ({ newPage: async () => page, close: async () => {} }) } } });
    assert.equal(result.capturedResponses.length, 0);
  }
});

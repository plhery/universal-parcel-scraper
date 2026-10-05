import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { EvriUkTracker } from './adapter.js';
import { requestEvriUkInPage } from './browser.js';
import { evriUkTrackingUrl, normalizeEvriUkNumber, parseEvriUk } from './parser.js';

// All identifiers, clocks, credentials and private-field markers here are invented.
const NUMBER = 'H000000000000001';
const URN = `urn:parcel_id:barcode:date:123456:${NUMBER}:2026-01-03`;
const history = () => JSON.parse(readFileSync(new URL('./fixtures/history.json', import.meta.url), 'utf8'));
const search = () => ({ parcels: [{ brand: { name: 'EVRI' }, identifiers: [
  { type: 'PARCEL_ID', value: '123456' }, { type: 'BARCODE', value: NUMBER },
] }] });

class FixedDate extends Date {
  constructor() { super('2026-01-03T10:00:00Z'); }
}

async function inPage(replies: Response[], overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const response = replies.shift();
    if (!response) throw new Error('Unexpected request');
    return Promise.resolve(response);
  };
  const run = runInNewContext(`(${requestEvriUkInPage.toString()})`, {
    location: { origin: 'https://www.evri.com', pathname: '/track-a-parcel' },
    AwsWafIntegration: { getToken: async () => 'SYNTHETIC_WAF_TOKEN', fetch: fetcher },
    fetch: fetcher, AbortSignal, TextDecoder, URL, Date: FixedDate, ...overrides,
  }) as typeof requestEvriUkInPage;
  return { result: await run({ number: NUMBER, budgetMs: 1_000 }), calls };
}

const keys = () => Response.json({ keys: { 'spa-customer-track-key': 'SYNTHETIC_CUSTOMER_KEY', 'spa-track-key': 'SYNTHETIC_TRACK_KEY' } });

describe('Evri UK anonymous history', () => {
  it('projects actual scans, preserves their codes, and excludes progress rails and private fields', () => {
    const result = parseEvriUk(history(), NUMBER, URN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-03T19:00:00Z' });
    expect(result.events).toHaveLength(6);
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'out_for_delivery', 'in_transit', 'in_transit', 'registered']);
    expect(result.events?.every(event => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|FUTURE_STAGE|proof/);
  });

  it.each(['wrong barcode', 'contradictory barcode', 'wrong urn'])('rejects %s', (kind) => {
    const payload = history();
    if (kind === 'wrong barcode') payload.results[0].parcelIdentifiers[0].value = 'H000000000000002';
    if (kind === 'contradictory barcode') payload.results[0].parcelIdentifiers.push({ type: 'BARCODE', value: 'H000000000000002' });
    if (kind === 'wrong urn') payload.results[0].uniqueId += ':different';
    expect(() => parseEvriUk(payload, NUMBER, URN)).toThrow('requested parcel');
  });

  it.each([{}, { results: [], failures: [] }, { results: [null], failures: [] }, { results: [], failures: [{}] }])('rejects incomplete envelopes: %j', payload => {
    expect(() => parseEvriUk(payload, NUMBER, URN)).toThrow();
  });

  it.each([{}, [], [null], [{ dateTime: '2026-01-03T09:00:00Z' }]])('does not turn malformed or empty history into success: %j', events => {
    const payload = history(); payload.results[0].trackingEvents = events;
    expect(() => parseEvriUk(payload, NUMBER, URN)).toThrow();
  });

  it('keeps unknown future wording unstaged and redacts unmapped delivery prose', () => {
    const payload = history();
    payload.results[0].trackingEvents = [
      { trackingPoint: { trackingPointCode: 'FUTURE', description: 'Your parcel will be delivered tomorrow' }, trackingStage: { trackingStageCode: 'UNKNOWN' }, dateTime: '2026-01-03T19:00:00Z' },
      { trackingPoint: { trackingPointCode: 'UNKNOWN', description: 'Delivered by PRIVATE RECIPIENT' }, trackingStage: { trackingStageCode: 'UNKNOWN' }, dateTime: '2026-01-03T18:00:00Z' },
    ];
    const result = parseEvriUk(payload, NUMBER, URN);
    expect(result.status).toBe('unknown');
    expect(result.events?.[0]).toMatchObject({ description: 'Your parcel will be delivered tomorrow' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result.events?.[1]).toMatchObject({ description: 'Delivery update' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('retains partial-clock provider order without assigning an overseas zone', () => {
    const payload = history();
    payload.results[0].trackingEvents.reverse();
    payload.results[0].trackingEvents[2].dateTime = '2026-01-03T10:00:00';
    const result = parseEvriUk(payload, NUMBER, URN);
    expect(result.events?.[0]?.provider_code).toBe('EXPECTED');
    expect(result.events?.[2]).toMatchObject({ provider_time_text: '2026-01-03T10:00:00' });
    expect(result.events?.[2]).not.toHaveProperty('time');
  });

  it.each(['2026-01-03T10:00:00', '2026-02-30T10:00:00Z', '2026-01-03T10:00:00+14:01'])('rejects activity consisting entirely of unresolved clocks: %s', clock => {
    const payload = history(); payload.results[0].trackingEvents.forEach((event: { dateTime: string }) => { event.dateTime = clock; });
    expect(() => parseEvriUk(payload, NUMBER, URN)).toThrow('no dated parcel activity');
  });

  it('normalizes the documented parcel format and requires a configured browser', async () => {
    expect(normalizeEvriUkNumber('h000 0000 0000 0001')).toBe(NUMBER);
    expect(evriUkTrackingUrl(NUMBER)).toContain(`/parcel/${NUMBER}/details`);
    expect(() => normalizeEvriUkNumber('12345678')).toThrow('16-character');
    expect(() => new EvriUkTracker().fetch(NUMBER)).toThrow('TRACKING_CHROMIUM_PATH');
    expect(() => new EvriUkTracker().fetch('wrong')).toThrow('16-character');
  });
});

describe('Evri UK page protocol', () => {
  it('uses fresh rotating keys only inside the page and binds the UTC-day URN', async () => {
    const { result, calls } = await inPage([keys(), Response.json(search()), Response.json(history())]);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('Expected history');
    expect(parseEvriUk(result.payload, NUMBER, result.urn).events).toHaveLength(6);
    expect(calls.map(call => call.url)).toEqual(['/protected/keys.json', `https://api.evri.com/customer-tracking/v1/search/${NUMBER}`,
      `https://tracking.platform-apis.evri.com/v1/parcels?uniqueIds=${encodeURIComponent(URN)}`]);
    expect(calls.every(call => call.init.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC_.*KEY|SYNTHETIC_WAF_TOKEN|PRIVATE/);
  });

  it.each([401, 403, 405, 429, 503])('returns the key rejection without sending search/history: HTTP %s', async status => {
    const { result, calls } = await inPage([new Response('', { status, headers: { 'retry-after': '120' } })]);
    expect(result).toMatchObject({ kind: 'http', phase: 'keys', status, retryAfter: '120' });
    expect(calls).toHaveLength(1);
  });

  it.each(['missing', 'ambiguous', 'foreign', 'redirect', 'wrong barcode', 'duplicate identifier'])('stops before history for %s search', async kind => {
    const payload = search();
    if (kind === 'missing') payload.parcels = [];
    if (kind === 'ambiguous') payload.parcels.push(payload.parcels[0]!);
    if (kind === 'foreign') payload.parcels[0]!.brand.name = 'OTHER';
    if (kind === 'redirect') Object.assign(payload.parcels[0]!, { externalRedirectUrl: 'https://private.example/opaque' });
    if (kind === 'wrong barcode') payload.parcels[0]!.identifiers[1]!.value = 'H000000000000002';
    if (kind === 'duplicate identifier') payload.parcels[0]!.identifiers.push({ type: 'BARCODE', value: NUMBER });
    const { result, calls } = await inPage([keys(), Response.json(payload)]);
    expect(result.kind).not.toBe('ok');
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('private.example');
  });

  it('bounds declared and streamed JSON bodies and rejects invalid JSON', async () => {
    for (const reply of [new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '100001' } }),
      new Response(' '.repeat(100001), { headers: { 'content-type': 'application/json' } }),
      new Response('invalid JSON', { headers: { 'content-type': 'application/json' } })]) {
      expect((await inPage([reply])).result.kind).toBe('schema');
    }
  });

  it.each(['dateTime', 'trackingPointCode', 'trackingStageCode', 'description', 'uniqueId'])('rejects a nested private object in %s before crossing the browser boundary', async field => {
    const payload = history();
    const marker = { nested: { address: 'PRIVATE_MARKER' } };
    if (field === 'uniqueId') payload.results[0].uniqueId = marker;
    else if (field === 'dateTime') payload.results[0].trackingEvents[0].dateTime = marker;
    else if (field === 'trackingStageCode') payload.results[0].trackingEvents[0].trackingStage.trackingStageCode = marker;
    else payload.results[0].trackingEvents[0].trackingPoint[field] = marker;
    const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(result.kind).toBe(field === 'uniqueId' ? 'identity' : 'schema');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MARKER');
  });

  it('rejects excessive history before copying scans across the browser boundary', async () => {
    const payload = history();
    payload.results[0].trackingEvents = Array.from({ length: 501 }, () => payload.results[0].trackingEvents[0]);
    const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(result.kind).toBe('schema');
    expect(result).not.toHaveProperty('payload');
  });

  it('rejects contradictory history barcodes and exports only the exact lookup identity', async () => {
    const payload = history();
    payload.results[0].parcelIdentifiers.push({ type: 'MERCHANT_REFERENCE', value: 'PRIVATE_MARKER' });
    const success = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(success.result.kind).toBe('ok');
    expect(JSON.stringify(success.result)).not.toContain('PRIVATE_MARKER');
    payload.results[0].parcelIdentifiers.push({ type: 'BARCODE', value: 'H000000000000002' });
    const wrong = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(wrong.result.kind).toBe('identity');
    expect(wrong.result).not.toHaveProperty('payload');
  });

  it.each(['dateTime', 'pointCode', 'stageCode', 'description'])('rejects nested private %s fields before browser projection', async field => {
    const payload = history();
    const row = payload.results[0].trackingEvents[0];
    const nested = { private: 'PRIVATE_NESTED_MARKER' };
    if (field === 'dateTime') row.dateTime = nested;
    if (field === 'pointCode') row.trackingPoint.trackingPointCode = nested;
    if (field === 'stageCode') row.trackingStage.trackingStageCode = nested;
    if (field === 'description') row.trackingPoint.description = nested;
    const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
    expect(result).toMatchObject({ kind: 'schema', phase: 'history' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NESTED_MARKER');
  });

  it('bounds scan count and scalar lengths before browser projection', async () => {
    for (const field of ['count', 'dateTime', 'pointCode', 'stageCode', 'description']) {
      const payload = history();
      const row = payload.results[0].trackingEvents[0];
      if (field === 'count') payload.results[0].trackingEvents = Array.from({ length: 501 }, () => row);
      if (field === 'dateTime') row.dateTime = 'x'.repeat(65);
      if (field === 'pointCode') row.trackingPoint.trackingPointCode = 'x'.repeat(65);
      if (field === 'stageCode') row.trackingStage.trackingStageCode = 'x'.repeat(65);
      if (field === 'description') row.trackingPoint.description = 'x'.repeat(1001);
      const { result } = await inPage([keys(), Response.json(search()), Response.json(payload)]);
      expect(result).toMatchObject({ kind: 'schema', phase: 'history' });
    }
  });

  it('rejects a foreign execution context before obtaining any keys', async () => {
    const { result, calls } = await inPage([], { location: { origin: 'https://private.example', pathname: '/track-a-parcel' } });
    expect(result.kind).toBe('context'); expect(calls).toHaveLength(0);
  });
});

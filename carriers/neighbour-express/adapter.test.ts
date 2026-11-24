import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { universalPlan } from '../../providers/plan.js';
import { adapter, NeighbourExpressTracker } from './adapter.js';
import { NEIGHBOUR_SHIPMENT_URL, neighbourLookupUrl, neighbourPageUrl, normalizeNeighbourNumber, parseNeighbour, parseNeighbourShipment } from './parser.js';

const NUMBER = 'NR746193820571', OTHER = 'NR746193820572';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const capture = (body: unknown = fixture(), extra: Record<string, unknown> = {}) => ({
  url: neighbourLookupUrl(NUMBER), status: 200, trackingNumberSubmitted: NUMBER, body: JSON.stringify(body), headers: {}, ...extra,
});
const reply = (rows: unknown[], extra: Record<string, unknown> = {}) => new Response(JSON.stringify({
  url: neighbourPageUrl(NUMBER), html: '', tier: 3, statusCode: 200, cookies: [], capturedResponses: rows, ...extra,
}), { headers: { 'Content-Type': 'application/json' } });
function harness(rows = [capture()], extra: Record<string, unknown> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(rows, extra));
  const tracker = new NeighbourExpressTracker({ fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') });
  return { tracker, fetcher };
}

describe('Neighbour Express return guest tracking', () => {
  it('preserves the whole identity, five native milestones and explicit event offsets', () => {
    const result = parseNeighbour(fixture(), NUMBER);
    expect(result).toMatchObject({ current_stage: 'delivered', canonical_tracking_number: NUMBER, last_update: '2026-01-14T10:19:14-05:00', timezone: 'UTC-05:00' });
    expect(result.events).toHaveLength(5);
    expect(result.events!.map(e => e.stage)).toEqual(['delivered', 'in_transit', 'in_transit', 'accepted', 'registered']);
    expect(result.events!.every(e => e.time?.endsWith('-05:00') && e.time_zone_basis === 'carrier')).toBe(true);
    expect(result.delivered_at).toBe('2026-01-14T10:19:14-05:00');
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|recipient|signature|remark|contact/);
  });

  it('keeps a stated winter offset even when Toronto uses summer time', () => {
    const data = fixture(); data.data.results[0].data[4].time = '2026-03-19 10:19:14';
    expect(parseNeighbour(data, NUMBER)).toMatchObject({ last_update: '2026-03-19T10:19:14-05:00', last_update_local: '2026-03-19T10:19:14' });
  });

  it.each([
    (d: ReturnType<typeof fixture>) => { d.data.results[0].trackno = OTHER; },
    (d: ReturnType<typeof fixture>) => { d.data.results.push(d.data.results[0]); },
    (d: ReturnType<typeof fixture>) => { d.data.results[0].data[4].time = '2026-02-30 10:19:14'; },
    (d: ReturnType<typeof fixture>) => { d.data.results[0].data[4].timezone = 'UTC+14:15'; },
    (d: ReturnType<typeof fixture>) => { d.data.results[0].data[4].timezone = 'EST'; },
    (d: ReturnType<typeof fixture>) => { delete d.data.results[0].data[4].timezone; },
    (d: ReturnType<typeof fixture>) => { d.data.results[0].data[4].status = true; },
  ])('rejects identity, event and clock changes', change => {
    const data = fixture(); change(data);
    expect(() => parseNeighbour(data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('does not declare an unknown or a pending verification to be missing', () => {
    expect(() => parseNeighbour({ code: '1', data: 0 }, NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge', reason: 'guest_verification_required' }));
    expect(() => parseNeighbour({ code: '0', data: { results: [] } }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const empty = fixture(); empty.data.results[0].data = [];
    expect(() => parseNeighbour(empty, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const value of [null, [], 'PRIVATE', { code: '0', data: null }]) expect(() => parseNeighbour(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('validates all rows before truncation and does not borrow an older known stage', () => {
    const data = fixture(); data.data.results[0].data[4].status = 999; data.data.results[0].data[4].statusText = 'Synthetic new milestone';
    expect(parseNeighbour(data, NUMBER).current_stage).toBe('unknown');
    const long = fixture(); long.data.results[0].data = Array.from({ length: 101 }, () => ({ ...long.data.results[0].data[0] }));
    expect(parseNeighbour(long, NUMBER)).toMatchObject({ history_truncated: true });
    long.data.results[0].data[100].time = '2026-02-30 10:00:00';
    expect(() => parseNeighbour(long, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('uses the supplied transport and whole URL capture within the caller budget', async () => {
    const h = harness(); await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetcher.mock.calls[0]!; expect(String(url)).toBe('https://trawl.invalid/scrape');
    const body = JSON.parse(String(init?.body)); expect(body).toMatchObject({ url: neighbourPageUrl(NUMBER), captureResponses: [neighbourLookupUrl(NUMBER)], skipHttp: true, maxTier: 3 });
    expect(body.maxTimeout).toBeLessThanOrEqual(40000); expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries only the native v3 verification signal once, keeping the final refusal', async () => {
    const h = harness(); h.fetcher.mockResolvedValueOnce(reply([capture({ code: '1', data: 0 })])).mockResolvedValueOnce(reply([capture()]));
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' }); expect(h.fetcher).toHaveBeenCalledTimes(2);
    const twice = harness([capture({ code: '1', data: 0 })]);
    await expect(twice.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', reason: 'guest_verification_required' });
    expect(twice.fetcher).toHaveBeenCalledTimes(2);
    const short = harness([capture({ code: '1', data: 0 })]);
    await expect(short.tracker.fetch(NUMBER, { budgetMs: 30000 })).rejects.toMatchObject({ kind: 'challenge' }); expect(short.fetcher).toHaveBeenCalledTimes(1);
  });

  it('requires the bound outgoing whole number and refuses multiple captures', async () => {
    for (const rows of [[capture(fixture(), { trackingNumberSubmitted: undefined })], [capture(fixture(), { trackingNumberSubmitted: OTHER })],
      [capture(), capture()]]) await expect(harness(rows).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture()], { url: neighbourPageUrl(NUMBER) + '#moved' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[401, 'challenge'], [403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])('preserves HTTP %i as %s', async (status, kind) => {
    const h = harness([capture(null, { status, headers: { 'retry-after': '120' } })]);
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 120000 } : {}) }); expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[{ error: 'invalid-json' }, 'schema'], [{ error: 'body-read' }, 'transport'], [{ truncated: true }, 'transport'],
    [{ base64Encoded: true }, 'transport'], [{ error: 'challenge-html' }, 'challenge']])('keeps capture failures distinct', async (extra, kind) => {
    await expect(harness([capture(fixture(), extra)]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind });
  });

  it('does not classify missing pages or browser-service endpoints as missing parcels', async () => {
    for (const statusCode of [0, 404, 410]) await expect(harness([], { statusCode }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    const h = harness(); h.fetcher.mockResolvedValue(new Response('missing service route', { status: 404 }));
    await expect(h.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], { timings: [{ reason: 'neighbour-network' }] }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('requires an active signal, supported return branch, browser and enough time before I/O', async () => {
    const h = harness(); for (const raw of ['N1234R', 'NX12', 'NR-ÉTÉ-12']) await expect(h.tracker.fetch(raw)).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 20000 })).rejects.toMatchObject({ kind: 'budget' });
    const controller = new AbortController(); controller.abort(); await expect(h.tracker.fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled(); expect(normalizeNeighbourNumber(NUMBER.toLowerCase())).toBe(NUMBER);
  });

  it('dispatches selected-carrier tracking without an HTTP recognizer or a number rule', async () => {
    const h = harness(); const a = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher: h.fetcher, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') });
    expect(a.recognize).toBeUndefined(); expect(a.recognizeWithBrowser).toBeUndefined();
    const result = await createTracker({ providers: [], trawlUrl: 'https://trawl.invalid', fetcher: h.fetcher }).track({ number: NUMBER, carrier: 'neighbour-express' });
    expect(result).toMatchObject({ source: 'neighbour-express', result: { current_stage: 'delivered' } }); expect(result.result.events).toHaveLength(5);
    for (const number of [NUMBER, 'PARTNER746193820571']) {
      expect(universalPlan({ carriers: ['neighbour-express'], trackingNumber: number }).sources.length).toBeGreaterThan(0);
    }
  });
});

const SHIPMENT = 'NX7461938205JY';
const shipmentFixture = (name = 'shipment-delivered') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
function shipmentHarness(...replies: (Response | Error)[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const reply of replies) {
    if (reply instanceof Error) fetcher.mockRejectedValueOnce(reply); else fetcher.mockResolvedValueOnce(reply);
  }
  const tracker = new NeighbourExpressTracker({ fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: null });
  return { tracker, fetcher };
}
const json = (body: unknown, status = 200, type = 'application/json;charset=utf-8') => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { status, headers: { 'Content-Type': type } });

describe('Neighbour Express shipment tracking', () => {
  it('reads every other reference through the shipment route, keeping zones, places and the page\'s completion code', () => {
    const result = parseNeighbourShipment(shipmentFixture(), SHIPMENT);
    expect(result).toMatchObject({ current_stage: 'delivered', canonical_tracking_number: SHIPMENT, last_update: '2026-01-13T16:40:05-05:00',
      last_update_local: '2026-01-13T16:40:05', timezone: 'UTC-05:00', delivered_at: '2026-01-13T16:40:05-05:00' });
    expect(result.events!.map(e => [e.provider_code, e.stage, e.location])).toEqual([
      ['203', 'delivered', 'Toronto, ON, Canada'], ['101', 'in_transit', 'Vaughan, ON, Canada'], ['100', 'registered', 'Vaughan, ON, Canada']]);
    expect(result.events![1]!.stage_source).toMatch(/^wording:/);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example\.invalid|signature/i);
  });

  it('marks 900 complete and reads offsets in every form the page accepts', () => {
    const data = shipmentFixture(); const rows = data.data[0].track;
    rows.push({ ...rows[2], code: 900, content: 'Order completed', time: '2026-01-14T08:00:00-05:00', timezone: 'UTC-05:00' });
    rows[0].timezone = 'UTC+8:00'; rows[1].timezone = 'UTC-04';
    const result = parseNeighbourShipment(data, SHIPMENT);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-01-14T08:00:00-05:00' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-01-10T09:15:00+08:00', time_zone: 'UTC+08:00' });
    expect(result.events![2]).toMatchObject({ time: '2026-01-11T14:02:30-04:00' });
    const found = shipmentFixture(); found.data[0].pkgNo = 'NX0000000000AB'; found.data[0].subOrderNo = SHIPMENT;
    expect(parseNeighbourShipment(found, SHIPMENT).canonical_tracking_number).toBe(SHIPMENT);
  });

  it('answers not found only on the route\'s own empty list or not-found code', () => {
    for (const data of [shipmentFixture('shipment-not-found'), { code: '500301', data: null, errmsg: 'not found' }]) {
      expect(() => parseNeighbourShipment(data, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    }
    expect(() => parseNeighbourShipment({ code: '1', errmsg: 'retry later' }, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'maintenance' }));
    expect(() => parseNeighbourShipment({ code: '401002', errmsg: 'unauthorized' }, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    const listed = shipmentFixture(); listed.data[0].track = [];
    expect(() => parseNeighbourShipment(listed, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it.each([
    (d: ReturnType<typeof shipmentFixture>) => { d.data[0].pkgNo = 'NX7461938205JZ'; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data.push(d.data[0]); },
    (d: ReturnType<typeof shipmentFixture>) => { d.code = '7'; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data = {}; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data[0].track = null; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data[0].track[2].time = '2026-02-30 10:00:00'; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data[0].track[2].timezone = 'EST'; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data[0].track[2].timezone = 'UTC+15'; },
    (d: ReturnType<typeof shipmentFixture>) => { delete d.data[0].track[2].timezone; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data[0].track[2].time = '2026-01-13T16:40:05-04:00'; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data[0].track[2].code = 'DLV'; },
    (d: ReturnType<typeof shipmentFixture>) => { d.data[0].track[2].content = ' '; },
  ])('rejects identity, scan and clock changes on the shipment route', change => {
    const data = shipmentFixture(); change(data);
    expect(() => parseNeighbourShipment(data, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown wording without a stage rather than borrowing an older one', () => {
    const data = shipmentFixture(); data.data[0].track[2] = { ...data.data[0].track[2], code: 777, content: 'Synthetic notice' };
    expect(parseNeighbourShipment(data, SHIPMENT)).toMatchObject({ current_stage: 'unknown', current_stage_source: 'none' });
  });

  it('posts the whole reference with an empty postcode through the supplied transport, without the browser', async () => {
    const h = shipmentHarness(json(shipmentFixture()));
    await expect(h.tracker.fetch(SHIPMENT.toLowerCase())).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetcher.mock.calls[0]!;
    expect(String(url)).toBe(NEIGHBOUR_SHIPMENT_URL); expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ pkgNos: SHIPMENT, zip: '' }); expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a network failure once and keeps HTTP, page and malformed replies distinct from a missing shipment', async () => {
    const retried = shipmentHarness(new TypeError('fetch failed'), json(shipmentFixture()));
    await expect(retried.tracker.fetch(SHIPMENT)).resolves.toMatchObject({ current_stage: 'delivered' }); expect(retried.fetcher).toHaveBeenCalledTimes(2);
    const cases: [Response, string][] = [[json({}, 403), 'challenge'], [json({}, 429), 'rate_limited'], [json('', 404), 'transport'],
      [json('', 302), 'transport'], [json('<!doctype html><title>Just a moment</title>', 200, 'text/html'), 'challenge'],
      [json('not json', 200, 'text/plain'), 'schema'], [json('{', 200), 'schema']];
    for (const [reply, kind] of cases) await expect(shipmentHarness(reply).tracker.fetch(SHIPMENT)).rejects.toMatchObject({ kind });
  });

  it('dispatches selected-carrier tracking to the shipment route without the browser service', async () => {
    const h = shipmentHarness(json(shipmentFixture()));
    const result = await createTracker({ providers: [], fetcher: h.fetcher }).track({ number: SHIPMENT, carrier: 'neighbour-express' });
    expect(result).toMatchObject({ source: 'neighbour-express', result: { current_stage: 'delivered' } });
  });
});

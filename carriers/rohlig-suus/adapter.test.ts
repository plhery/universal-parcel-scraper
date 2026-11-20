import { describe, expect, it, vi } from 'vitest';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import redelivered from './fixtures/redelivered.json' with { type: 'json' };
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { adapter, RohligSuusTracker, rohligSuusOrdersUrl, rohligSuusPageUrl } from './adapter.js';
import { normalizeRohligSuusNumber, parseRohligSuus } from './parser.js';
import { rohligSuusStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = delivered.parcelNumber;
const ORDERS = rohligSuusOrdersUrl(NUMBER);
const capture = (data: unknown = delivered, extra: Record<string, unknown> = {}) => ({ url: ORDERS, status: 200, trackingNumberSubmitted: NUMBER,
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'rohlig-suus-reply') {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url: rohligSuusPageUrl(NUMBER), html: '', statusCode: 200,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new RohligSuusTracker(environment) };
}

describe('Rohlig SUUS Logistics guest tracker', () => {
  it('reads the events newest first on their wall clocks, with towns and stages', () => {
    const result = parseRohligSuus(delivered, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Shipment delivered',
      last_update: null, last_update_local: '2026-07-28T02:37:01', expected_delivery: null, destination_country: 'PL' });
    expect(result.events).toHaveLength(6);
    expect(result.events?.[0]).toEqual({ local_time: '2026-07-28T02:37:01', description: 'Shipment invoiced', location: 'Sosnowiec', provider_code: '53' });
    expect(result.events?.[1]).toMatchObject({ local_time: '2026-07-21T12:36:58', location: 'Sokołów', provider_code: '39', stage: 'delivered' });
    expect(result.events?.at(-1)).toMatchObject({ local_time: '2026-07-17T14:48:53', description: 'Shipment created', stage: 'registered' });
    expect(result.events?.every(event => !event.time)).toBe(true);
  });

  it('reads a failed attempt and the second round', () => {
    const result = parseRohligSuus(redelivered, redelivered.parcelNumber);
    expect(result).toMatchObject({ current_stage: 'delivered' });
    expect(result.events?.find(e => e.provider_code === '73')).toMatchObject({ stage: 'failed_attempt', location: 'Gdansk' });
    expect(result.events?.find(e => e.provider_code === '134')).toMatchObject({ description: 'Out for re-Delivery', stage: 'out_for_delivery', location: 'Nowa Wieś' });
  });

  it('keeps the planned day until delivery, and the planned-delivery note', () => {
    const events = [{ statusId: 327, created: '2026-07-20T14:00:00', location: 'KTW', speedCode: 'EML01', eventNote: '21.07.2026' },
      ...delivered.events.filter(e => e.statusId === 34 || e.statusId === 32)];
    const result = parseRohligSuus({ ...delivered, events }, NUMBER);
    expect(result).toMatchObject({ current_stage: 'accepted', last_status_text: 'Picked up from the sender', expected_delivery: '2026-07-21' });
    expect(result.events?.[0]).toMatchObject({ description: 'Planned delivery date: 21.07.2026' });
    expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('drops hidden and repeated events, and keeps another number or an empty history apart', () => {
    const hidden = { statusId: 258, created: '2026-07-29T00:00:00', location: 'KTW', speedCode: 'template', eventNote: null };
    expect(parseRohligSuus({ ...delivered, events: [hidden, ...delivered.events, delivered.events[1]] }, NUMBER).events).toHaveLength(6);
    expect(() => parseRohligSuus({ ...delivered, events: [hidden] }, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseRohligSuus({ ...delivered, events: null }, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseRohligSuus({ ...delivered, parcelNumber: 'ZZZZ000000001' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseRohligSuus({ ...delivered, events: [{ statusId: 39, created: '21.07.2026 12:36' }] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeRohligSuusNumber(' lkrc 240028939 ')).toBe('LKRC240028939');
    expect(() => normalizeRohligSuusNumber('https://portal.suus.com/')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it.each(statuses.entries)('maps $code $wording', entry => {
    expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording))).toBe(entry.stage);
    expect(rohligSuusStage(entry.code)).toBe(entry.stage);
  });

  it('asks the browser service for the order page and its bound lookup', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ url: rohligSuusPageUrl(NUMBER), skipHttp: true, maxTier: 3, captureResponses: [ORDERS] });
    expect(adapter(h.environment)).toMatchObject({ id: 'rohlig-suus', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads an empty 204 as not found, an empty 500 as a refused token, and other answers as what they are', async () => {
    await expect(harness([capture(null, { status: 204, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture(null, { status: 500, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 400, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 400 });
    await expect(harness([capture(null, { status: 429, body: '', headers: { 'retry-after': '60' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture(null, { status: 403, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(delivered, { trackingNumberSubmitted: 'ZZZZ000000001' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(delivered, { truncated: true })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { body: '<html>', error: 'invalid-json' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 'rohlig-suus-capture_missing').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'rohlig-suus-runtime').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new RohligSuusTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
});

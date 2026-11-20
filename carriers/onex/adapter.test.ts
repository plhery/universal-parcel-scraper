import { describe, expect, it, vi } from 'vitest';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import exported from './fixtures/export.json' with { type: 'json' };
import imported from './fixtures/import.json' with { type: 'json' };
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { adapter, OnexTracker, onexLookupUrl, onexPageUrl } from './adapter.js';
import { normalizeOnexNumber, parseOnex } from './parser.js';
import { onexStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'TM800329354AM';
const LOOKUP = onexLookupUrl();
const capture = (data: unknown = delivered, extra: Record<string, unknown> = {}) => ({ url: LOOKUP, status: 200, trackingNumberSubmitted: NUMBER,
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'onex-reply', statusCode = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url: onexPageUrl(NUMBER), html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new OnexTracker(environment) };
}
const unknown = { status: 1, data: { import: false, export: false, track: null, iherb: false } };

describe('Onex tracker', () => {
  it('reads a delivered order’s events newest first on their wall clocks', () => {
    const result = parseOnex(delivered);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Order Delivered', last_update: null, last_update_local: '2024-05-11T19:51:23', expected_delivery: null });
    expect(result.events).toHaveLength(6);
    expect(result.events?.[0]).toEqual({ local_time: '2024-05-11T19:51:23', description: 'Order Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events?.find(e => e.description === 'In Custom clearance')).toMatchObject({ stage: 'customs' });
    expect(result.events?.at(-1)).toMatchObject({ local_time: '2024-05-02T06:56:44', stage: 'in_transit' });
    expect(result.events?.every(event => !event.time && !event.provider_code)).toBe(true);
  });

  it('reads an import’s dates with the page’s captions, and its estimate until it is received', () => {
    const result = parseOnex(imported);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Armenia',
      last_update_local: '2026-01-17T11:45:00', expected_delivery: '2026-01-19' });
    expect(result.events?.map(e => [e.provider_code, e.description, e.stage])).toEqual([
      ['import-in-armenia', 'In Armenia', 'in_transit'], ['import-departed', 'Departed', 'in_transit'],
      ['import-identified', 'The parcel has been identified', 'accepted'], ['import-scanned', 'Scanned', 'accepted']]);
    const received = parseOnex({ ...imported, data: { ...imported.data, import: { ...imported.data.import, receiveddate: '2026-01-18 15:00:00' } } });
    expect(received).toMatchObject({ status: 'delivered', last_status_text: 'Received', expected_delivery: null });
    const unsure = parseOnex({ ...imported, data: { ...imported.data, import: { ...imported.data.import, no_estimated_date: 1 } } });
    expect(unsure.expected_delivery).toBeNull();
  });

  it('reads an export to its hand-over to the post', () => {
    const result = parseOnex(exported);
    expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Delivered to the postal service', expected_delivery: null });
    expect(result.events?.at(-1)).toMatchObject({ provider_code: 'export-received', description: 'Received', stage: 'accepted' });
    const early = parseOnex({ ...exported, data: { ...exported.data, export: { ...exported.data.export, third_date: null, four_date: '' } } });
    expect(early).toMatchObject({ last_status_text: 'Departed', expected_delivery: '2026-02-10' });
  });

  it('keeps a location, drops repeats, and reads an unknown, an empty or an unreadable answer as what it is', () => {
    const one = { event_description: 'Out for Delivery', date: '2024-05-10 11:34:45', pickup_point: { long_name: 'Onex branch' } };
    expect(parseOnex({ status: 1, data: { iherb: [one, one] } }).events).toEqual([{ local_time: '2024-05-10T11:34:45',
      description: 'Out for Delivery', location: 'Onex branch', stage: 'out_for_delivery', stage_source: 'carrier_map' }]);
    expect(parseOnex({ status: 1, data: { iherb: [{ event_description: 'Parcel returned to sender', date: '2024-05-10 11:34:45' }] } }).events?.[0])
      .toMatchObject({ stage: 'returned', stage_source: expect.stringMatching(/^wording:/) });
    expect(() => parseOnex(unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseOnex({ status: 1, data: { ...unknown.data, track: true } })).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseOnex({ status: 1, data: { ...unknown.data, iherb: [] } })).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseOnex({ status: 1, data: { ...unknown.data, import: { receiveddate: '0000-00-00 00:00:00' } } })).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseOnex({ status: 0, data: unknown.data })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOnex({ status: 1, data: { iherb: 'unreadable' } })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOnex({ status: 1, data: { import: 'unreadable' } })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOnex({ status: 1, data: { iherb: [{ event_description: 'Out for Delivery', date: '10.05.2024 11:34' }] } })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizeOnexNumber(' tm 800329354-am ')).toBe(NUMBER);
    expect(() => normalizeOnexNumber('https://onex.am/')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it.each(statuses.entries)('maps $wording', entry => {
    const code = 'code' in entry ? entry.code : undefined;
    expect(statusMap.stage(code ?? null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
    expect(onexStage(code, entry.wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
  });

  it('asks the browser service for the tracker and its bound lookup', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ url: `https://onex.am/en/onextrack?track=${NUMBER}`,
      skipHttp: true, maxTier: 3, captureResponses: ['https://onex.am/en/onextrack/findtrackingcodeimport'] });
    expect(adapter(h.environment)).toMatchObject({ id: 'onex', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads the lookup’s and the page’s refusals as what they are', async () => {
    await expect(harness([capture(unknown)]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture(null, { status: 403, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { body: null, error: 'challenge-html' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 400, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport', status: 400 });
    await expect(harness([capture(null, { status: 500, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    await expect(harness([capture(null, { status: 429, body: '', headers: { 'retry-after': '60' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture(delivered, { trackingNumberSubmitted: 'ZZZZ000000001' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(delivered, { truncated: true })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { body: null, error: 'invalid-json' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 'onex-capture_missing', 403).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'onex-capture_missing').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'onex-runtime').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new OnexTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
});

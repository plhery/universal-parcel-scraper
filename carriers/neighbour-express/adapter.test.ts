import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { createTracker } from '../../facade/index.js';
import { universalPlan } from '../../providers/plan.js';
import { adapter, NeighbourExpressTracker } from './adapter.js';
import { neighbourLookupUrl, neighbourPageUrl, normalizeNeighbourNumber, parseNeighbour } from './parser.js';

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
    const h = harness(); await expect(h.tracker.fetch('POSTCODEBRANCH')).rejects.toMatchObject({ kind: 'invalid_input' });
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

import { describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/delivered.json' with { type: 'json' };
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, PeddlerTracker, peddlerLoaderUrl, peddlerPageUrl } from './adapter.js';
import { normalizePeddlerNumber, parsePeddler } from './parser.js';
import { peddlerStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import { normalizeStatusWording } from '../../core/status/statusMap.js';

const NUMBER = fixture.data.inquiryNumber;
const LOADER = peddlerLoaderUrl(NUMBER);
const capture = (data: unknown = fixture, extra: Record<string, unknown> = {}) => ({ url: LOADER, status: 200, trackingNumberSubmitted: NUMBER,
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'peddler-reply') {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url: peddlerPageUrl(NUMBER), html: '', statusCode: 200,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new PeddlerTracker(environment) };
}

describe('Peddler guest tracker', () => {
  it('reads the events newest first with their instants, codes and stages', () => {
    const result = parsePeddler(fixture, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-03-18T11:32:17.374Z', delivered_at: '2026-03-18T11:32:17.374Z', expected_delivery: null, timezone: 'Europe/Amsterdam' });
    expect(result.events).toHaveLength(11);
    expect(result.events?.at(-1)).toMatchObject({ time: '2026-03-09T22:47:49.686Z', description: 'Shipment confirmed', provider_code: '100', stage: 'registered' });
    expect(result.events?.find(e => e.provider_code === '603')).toMatchObject({ description: 'Delivery attempt failed: Incomplete address; missing details', stage: 'failed_attempt' });
    expect(result.events?.find(e => e.provider_code === '1100')).toMatchObject({ description: 'Delivery address updated' });
    expect(result.events?.find(e => e.provider_code === '1100')?.stage).toBeUndefined();
    expect(result.events?.find(e => e.provider_code === '700')?.stage).toBeUndefined();
  });

  it('keeps an estimate until delivery', () => {
    const events = fixture.data.package.events.slice(0, 5);
    expect(parsePeddler({ data: { ...fixture.data, package: { ...fixture.data.package, events } } }, NUMBER))
      .toMatchObject({ current_stage: 'out_for_delivery', expected_delivery: '2026-03-18T11:32:17.374Z' });
  });

  it('keeps a missing number, an empty record and another number apart', () => {
    expect(() => parsePeddler({ error: 'Consignment not found' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePeddler({ error: 'Something else' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePeddler({ data: { inquiryNumber: NUMBER } }, NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parsePeddler({ data: { inquiryNumber: 'NLEXP0000000001INTPED', package: fixture.data.package } }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePeddler({ data: { ...fixture.data, package: { ...fixture.data.package, events: [{ code: 100, ts: '2026-03-09 22:47' }] } } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(normalizePeddlerNumber(' nlexp0024995356intped ')).toBe(NUMBER);
    expect(() => normalizePeddlerNumber('https://track.pdlr.nl/')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it.each(statuses.entries)('maps $wording', entry => {
    expect(statusMap.stage(entry.code ?? '', normalizeStatusWording(entry.wording))).toBe(entry.stage);
    if (entry.code) expect(peddlerStage(entry.code, entry.wording)?.stage).toBe(entry.stage);
  });

  it('asks the browser service for the form and its bound data request', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ url: peddlerPageUrl(NUMBER), skipHttp: true, maxTier: 3, captureResponses: [LOADER] });
    expect(adapter(h.environment)).toMatchObject({ id: 'peddler', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads an unknown number’s 404 as not found, and other refusals as what they are', async () => {
    await expect(harness([capture({ error: 'Consignment not found' }, { status: 404 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture(null, { status: 404, body: '<html></html>' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(null, { status: 429, headers: { 'retry-after': '60' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture(null, { status: 403 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(fixture, { trackingNumberSubmitted: 'NLEXP0000000001INTPED' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(fixture, { truncated: true })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'peddler-verification_unfinished').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'peddler-verification_refused').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'peddler-capture_missing').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new PeddlerTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
});

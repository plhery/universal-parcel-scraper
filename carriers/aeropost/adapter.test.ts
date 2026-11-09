import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import type { TrawlCapturedResponse } from '../../core/transport/trawl.js';
import { adapter, AeropostTracker } from './adapter.js';
import { AEROPOST_API, normalizeAeropostNumber, parseAeropost } from './parser.js';
import { aeropostStage } from './status.js';

const NUMBER = 'CR7420873058';
const row = (code = 1000, status = 'Proof of Delivery', date = '2025-02-10 15:20:00') => ({ code, status, date_time: date, country_code: 'CR' });
const payload = () => ({ events: [row(), row(400, 'Tendered to a Local Courier', '2025-02-09 15:20:00'), row(280, 'Received Information', '2025-02-08 15:20:00')] });
const capture = (body: unknown = payload(), status = 200, extra: Partial<TrawlCapturedResponse> = {}): TrawlCapturedResponse => ({ url: AEROPOST_API, status,
  headers: {}, body: JSON.stringify(body), truncated: false, base64Encoded: false, error: null, trackingNumberSubmitted: NUMBER, ...extra });
function fixture(entries = [capture()]) {
  const trawl = new TrawlClient('https://trawl.invalid');
  const scrape = vi.spyOn(trawl, 'scrape').mockResolvedValue({ url: `https://aeropost.com/en/tracking/${NUMBER}`, html: '', cookies: [], userAgent: null,
    tier: 3, statusCode: 200, capturedResponses: entries, raw: {} });
  return { trawl, scrape, tracker: new AeropostTracker({ trawl }) };
}

describe('Aeropost shipper tracking', () => {
  it('keeps local clocks, code meanings and the native newest-first sequence', () => {
    const result = parseAeropost({ ...payload(), recipient: 'PRIVATE', shipment_created: 'PRIVATE', token: 'PRIVATE' });
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_update_local: '2025-02-10T15:20:00' });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'in_transit', 'registered']);
    expect(result.events?.[0]).toMatchObject({ local_time: '2025-02-10T15:20:00', location: 'CR', provider_code: '1000' });
    expect(result.events?.every(event => event.time === undefined && event.time_zone === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(aeropostStage('1500')).toBeUndefined();
  });
  it('rejects malformed rows and calendar dates while leaving empty history inconclusive', () => {
    for (const body of [null, { events: null }, { events: [null] }, { events: [row(1000, 'Proof', '2025-02-30 10:00:00')] },
      { events: [{ ...row(), code: {} }] }, { events: [{ ...row(), country_code: 'Costa Rica' }] }, { events: Array.from({ length: 501 }, () => row()) }]) {
      expect(() => parseAeropost(body)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const events of [[], [row(1500, 'Parcel still in process')]]) expect(() => parseAeropost({ events })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(normalizeAeropostNumber(' cr 7420873058 ')).toBe(NUMBER);
    expect(() => normalizeAeropostNumber('MIA7420873058')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
  it('bounds projected history and drops exact duplicate rows', () => {
    expect(parseAeropost({ events: [row(), row()] }).events).toHaveLength(1);
    const result = parseAeropost({ events: Array.from({ length: 101 }, (_, i) => row(9000 + i, 'Unmapped scan')) });
    expect(result.events).toHaveLength(100); expect(result.history_truncated).toBe(true);
  });
  it('requires the exact bound whole-number capture and supplies the shared deadline', async () => {
    const f = fixture(); await expect(f.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(f.scrape).toHaveBeenCalledWith(expect.objectContaining({ skipHttp: true, maxTier: 3, captureResponses: [AEROPOST_API] }),
      expect.objectContaining({ signal: expect.any(AbortSignal), captureWindow: 'last', requireSolved: false }));
    expect(f.scrape.mock.calls[0]![1].timeoutMs).toBeGreaterThan(2000);
    for (const bound of [undefined, NUMBER + '9']) {
      const failed = fixture([capture(payload(), 200, { trackingNumberSubmitted: bound })]);
      await expect(failed.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: bound ? 'schema' : 'transport' });
    }
  });
  it('retains challenge and rate-limit failures and accepts only the native missing signature', async () => {
    for (const [status, kind] of [[400, 'challenge'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const) {
      const f = fixture([capture(null, status, { body: null, headers: { 'retry-after': '8' } })]);
      await expect(f.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 8000 } : {}) });
    }
    const absent = fixture([capture({ statusCode: 404, statusMessage: 'Tracking information not found' }, 404)]);
    await expect(absent.tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(fixture([capture({}, 404)]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(fixture([capture(payload()), capture(null, 429, { body: null })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
  });
  it('supports browser-only recognition and keeps cancellation, budget and service errors private', async () => {
    const f = fixture(); const instance = adapter({ trawl: f.trawl, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    expect(instance.recognize).toBeUndefined();
    expect(instance.recognizeWithBrowser).toBeUndefined();
    f.scrape.mockClear(); await expect(f.tracker.fetch(NUMBER, { signal: AbortSignal.abort(new Error('stop')) })).rejects.toThrow('stop');
    await expect(f.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' }); expect(f.scrape).not.toHaveBeenCalled();
    f.scrape.mockRejectedValueOnce(new Error('PRIVATE verification token'));
    const error = await f.tracker.fetch(NUMBER).catch((error: unknown) => error);
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });
});

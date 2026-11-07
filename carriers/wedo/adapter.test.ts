import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { normalizeAllegroOneNumber } from '../allegro-one/parser.js';
import { adapter, WEDO_ENDPOINT, WedoTracker, wedoTrackingUrl } from './adapter.js';
import { normalizeWedoNumber, parseWedo, PROVIDER } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = '1ZZ00000001';
const text = () => readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const fixture = (): { status: Record<string, unknown>[] } => JSON.parse(text());
const reply = (body = text(), status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/vnd.allegro.internal.v1+json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('WeDo Czech guest tracker', () => {
  it('binds the whole normalized label to the Czech route and asks for the supported English locale', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply());
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new WedoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(' 1zz-0000.0001 ', { budgetMs: 1000.5 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(WEDO_ENDPOINT + '?packageNo=' + NUMBER);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/vnd.allegro.internal.v1+json', 'Accept-Language': 'en-US', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(init?.method ?? 'GET').toBe('GET');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(new Headers(init?.headers).has('Cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'wedo', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing Czech catalog scope separate from Polish labels and package-piece barcodes', () => {
    for (const number of [NUMBER, '81Z00000001', '1ZZ00000002']) {
      expect(normalizeWedoNumber(number.toLowerCase())).toBe(number);
      expect(detectCarrierMatch(number).candidates).toContain('wedo');
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'wedo', confidence: 'high' });
      expect(() => normalizeAllegroOneNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    for (const number of ['A0ZZ000001', 'AD0ZZZZZZZZZZ0001', 'ALE900000000001', '12345678901',
      '7D100000001', '7X100000001', NUMBER + '*001001', NUMBER + '-001', '1ZZ0000000', '1ZZ000000011', '1_Z00000001', 'x'.repeat(65)]) {
      expect(() => normalizeWedoNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(wedoTrackingUrl(NUMBER)).toBe(WEDO_ENDPOINT + '?packageNo=' + NUMBER);
    expect(parseTrackingInput('https://onedelivery.cz/sledovani-zasilky?numer=' + NUMBER))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'wedo', source: 'link' });
  });

  it('projects all dated logistics scans, removes duplicates and discards unused row details', () => {
    const result = parseWedo(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel has been delivered', last_update: '2026-08-12T14:35:01Z',
      delivered_at: '2026-08-12T14:35:01Z', expected_delivery: null });
    expect(result.events!.map(event => event.stage)).toEqual([
      'delivered', 'ready_for_pickup', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered',
    ]);
    expect(result.events!.every(event => event.stage_source === 'carrier_map' && !event.local_time && !event.location)).toBe(true);
    expect(result.history_truncated).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|recipient|address/);
    expect(parseWedo({ status: fixture().status.reverse() }, NUMBER)).toEqual(result);
  });

  it('preserves explicit offset digits and zero-millisecond precision', () => {
    const payload = fixture();
    payload.status[0]!.eventTimestamp = '2026-08-12T14:35:01.000+02:00';
    const result = parseWedo(payload, NUMBER);
    expect(result.last_update).toBe('2026-08-12T14:35:01.000+02:00');
    expect(result.delivered_at).toBe(result.last_update);
    expect(result.events![0]!.time).toBe(result.last_update);
    expect(result.events![1]!.time).toBe('2026-08-12T08:20:00.125Z');
  });

  it.each(['2026-02-30T14:35:01Z', '2026-08-12T14:35:01', '2026-08-12T14:35:01+02:99',
    '2026-08-12T14:35:01+99:00', '2026-08-12T14:35:01.1234Z', 'not a clock'])(
    'rejects an unresolved or malformed source clock', clock => {
      const payload = fixture(); payload.status[0]!.eventTimestamp = clock;
      expect(() => parseWedo(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema', provider: PROVIDER }));
    });

  it('keeps empty retained histories inconclusive without retrying them', async () => {
    for (const status of [[], null]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify({ status })));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it('does not expose unknown prose, and a hidden wording does not cut the history short', () => {
    const payload = fixture();
    payload.status[1]!.description = 'Signed by PRIVATE person at PRIVATE address';
    const result = parseWedo(payload, NUMBER);
    expect(result.events![1]).toMatchObject({ description: 'Tracking update' });
    expect(result.events![1]!.stage).toBeUndefined();
    expect(result.history_truncated).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each([{}, [], { status: {} }, { status: [null] }, { status: [], packageNo: '1ZZ00000002' }])(
    'rejects changed schemas or unexpected identity fields', payload => {
      expect(() => parseWedo(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    });

  it('validates the complete source before its output cap and rejects malformed wording', () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      eventTimestamp: new Date(Date.UTC(2026, 7, 11) + index * 1000).toISOString(),
      description: 'Parcel has been accepted at the sorting center',
    }));
    const result = parseWedo({ status: rows }, NUMBER);
    expect(result.events).toHaveLength(100);
    expect(result.history_truncated).toBe(true);
    expect(() => parseWedo({ status: [...rows, { ...rows[0], eventTimestamp: 'bad clock' }] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWedo({ status: Array.from({ length: 301 }, () => rows[0]) }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const description of ['', ' ', null, 42, 'x'.repeat(1001)]) {
      const payload = fixture(); payload.status[0]!.description = description;
      expect(() => parseWedo(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps pickup-point withdrawal and delivery back to the sender distinct', () => {
    const words = ['Parcel has been returned to the sender', 'Parcel has been picked up by the courier',
      'Time for parcel pick-up has expired', 'Parcel is awaiting pick-up', 'Parcel has been prepared by the sender'];
    const rows = words.map((description, index) => ({
      eventTimestamp: new Date(Date.UTC(2026, 7, 15 - index, 12)).toISOString(), description,
    }));
    const result = parseWedo({ status: rows }, NUMBER);
    expect(result.current_stage).toBe('returned');
    expect(result.events!.map(event => event.stage)).toEqual(['returned', 'exception', 'exception', 'ready_for_pickup', 'registered']);
    expect(result.delivered_at).toBeUndefined();
  });

  it.each([[400, 'indeterminate'], [404, 'indeterminate'], [406, 'indeterminate'], [410, 'indeterminate'],
    [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves a service HTTP failure without treating it as parcel absence', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('{}', status, { 'Retry-After': '120' }));
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('preserves the rate-limit retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply('{}', 429, { 'Retry-After': '120' }));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
  });

  it('rejects redirects and a changed whole-number response route', async () => {
    const moved = new Response(null, { status: 302, headers: { Location: 'https://example.invalid/' } });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(moved)).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    for (const changed of [WEDO_ENDPOINT + '?packageNo=' + NUMBER + '9', 'https://edge.allegro.pl/ad/tracking?packageNo=' + NUMBER]) {
      const response = reply(); Object.defineProperty(response, 'url', { value: changed });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'schema' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['<html><script src="https://ct.captcha-delivery.com/c.js"></script></html>', 'challenge'],
    ['<html><script>window._cf_chl_opt={}</script></html>', 'challenge'],
    ['<html>Maintenance</html>', 'schema'],
    ['not JSON', 'schema'],
  ])('keeps blocked HTML and malformed responses separate from empty history', async (body, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries one network failure through the recorded retry step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply());
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new WedoTracker({ fetcher, recorder }).fetch(NUMBER, { budgetMs: 1000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'wedo', step: 'retry', outcome: 'ok' }));
  });

  it('honors cancellation and rejects unsupported labels without HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: 'A0ZZ000001' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ends a hanging request inside the caller deadline', async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    await expect(carrier(fetcher).track({ number: NUMBER }, { budgetMs: 20.5 })).rejects.toThrow();
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('bounds HTTP response bytes before parsing', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify({ status: [], padding: 'x'.repeat(256 * 1024) })));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
  });

  it('exposes only native tracking steps without broadening HTTP recognition', () => {
    const instance = carrier(vi.fn<typeof fetch>());
    expect(instance.steps).toEqual(['direct', 'retry']);
    expect(instance.recognize).toBeUndefined();
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).not.toContain('wedo');
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording))).toBe(entry.stage);
    }
  });

  it('routes the high-confidence label and exact current tracking link to native history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply());
    const registry = new AdapterRegistry({ factories: { wedo: adapter }, carriers: { wedo: 'wedo' } },
      { fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    const tracker = createTracker({ registry, providers: [], env: {} });
    const direct = await tracker.track({ number: NUMBER }, { budgetMs: 1000 });
    expect(direct).toMatchObject({ source: 'wedo', result: { current_stage: 'delivered' } });
    const parsed = parseTrackingInput('https://onedelivery.cz/sledovani-zasilky?numer=' + NUMBER);
    expect(parsed).toMatchObject({ trackingNumber: NUMBER, carrier: 'wedo', source: 'link' });
    const linked = await tracker.track({ number: parsed.trackingNumber, carrier: parsed.carrier }, { budgetMs: 1000 });
    expect(linked).toMatchObject({ source: 'wedo', result: { current_stage: 'delivered' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([url]) => String(url) === WEDO_ENDPOINT + '?packageNo=' + NUMBER)).toBe(true);
  });
});

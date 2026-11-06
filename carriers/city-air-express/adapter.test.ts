import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { isCityAirExpressReference } from '../../core/detection/cityAirExpress.js';
import { CityAirExpressTracker, adapter } from './adapter.js';
import { MAX_BYTES, normalizeCityAirExpressNumber, parseCityAirExpress, TRACKING_BASE } from './parser.js';
import { cityAirExpressStage } from './status.js';

const NUMBER = 'MN846291';
const DELIVERY = 'Delivered to SYNTHETIC RECIPIENT at 13:42 on 15-07-2026';
const fixture = () => readFileSync(new URL('./fixtures/tracking.html', import.meta.url), 'utf8');
const unknown = () => readFileSync(new URL('./fixtures/unknown.html', import.meta.url), 'utf8');
const htmlResponse = (body = fixture(), status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const empty = () => { const $ = load(fixture()); $('.scrollable').empty(); return $.html(); };

describe('City Air Express guest history', () => {
  it('binds the full heading, deduplicates and preserves minute wall clocks without protected details', () => {
    const result = parseCityAirExpress(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-07-15T13:42', expected_delivery: null });
    expect(result.events).toHaveLength(3);
    expect(result.events!.map(event => event.stage)).toEqual(['delivered', 'accepted', 'registered']);
    expect(result.events!.map(event => event.local_time)).toEqual(['2026-07-15T13:42', '2026-07-14T09:12', '2026-07-13T18:05']);
    expect(result.events!.every(event => !event.time && !event.location)).toBe(true);
    expect(result).not.toHaveProperty('delivered_at'); expect(result.history_truncated).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|RECIPIENT|POSTCODE|SIGNATURE/);
  });

  it('requires one exact heading in its history panel', () => {
    for (const html of [fixture().replace(NUMBER, NUMBER + '0'), fixture().replace(NUMBER, 'MN846292'),
      fixture().replace('<h3>TRACKING FOR', '<h3>OTHER TRACKING FOR'),
      fixture().replace('</body>', '<h3>TRACKING FOR ' + NUMBER + '</h3></body>'),
      fixture().replace('tracking-header', 'other-header')]) {
      expect(() => parseCityAirExpress(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('accepts only the exact bound absence notice, without mixed history or hidden placeholders', () => {
    expect(() => parseCityAirExpress(unknown(), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const html of [unknown().replace(NUMBER, NUMBER + '0'), unknown().replace('find job', 'complete tracking for'),
      fixture().replace('</body>', '<span>Sorry, we could not find job ' + NUMBER + '.</span></body>'),
      unknown().replace('<span>', '<span hidden>')]) {
      expect(() => parseCityAirExpress(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseCityAirExpress(empty(), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'parcel_found' }));
  });

  it('keeps unknown wording generic and incomplete without guessing its latest stage', () => {
    const result = parseCityAirExpress(fixture().replace('<div class="event-status">' + DELIVERY + '</div>',
      '<div class="event-status">SYNTHETIC PERSON received update, private@example.invalid</div>'), NUMBER);
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
    expect(result.events![0]).toMatchObject({ description: 'Tracking update', local_time: '2026-07-15T13:42' });
    expect(result.history_truncated).toBe(true); expect(JSON.stringify(result)).not.toMatch(/PERSON|example.invalid/);
    expect(cityAirExpressStage(null, 'Data processed at CAEBFS')).toBe('registered');
    expect(cityAirExpressStage(null, 'Job received at Belfast Depot')).toBe('accepted');
    expect(cityAirExpressStage(null, 'Expected delivery')).toBeUndefined();
  });

  it('requires the clock embedded in delivery prose to agree without retaining the recipient', () => {
    expect(() => parseCityAirExpress(fixture().replace('at 13:42 on', 'at 14:42 on'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const result = parseCityAirExpress(fixture().replace(DELIVERY, 'Delivered'), NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.events![0]!.description).toBe('Delivered');
  });

  it.each(['31 Feb 2026 13:42', '15 Xxx 2026 13:42', '15 Jul 2026 24:42', '15 Jul 26 13:42', '15 Jul 2026 13:42:00'])(
    'rejects an invalid or changed scan clock: %s', value => {
      expect(() => parseCityAirExpress(fixture().replace('15 Jul 2026 13:42', value), NUMBER))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    });

  it('validates every source row before the output cap', () => {
    const $ = load(fixture());
    const first = $('.event').first().clone();
    for (let index = 0; index < 102; index++) {
      const row = first.clone(); row.find('.event-status').text('Job received at Belfast Depot');
      row.find('.event-time').text('14 Jul 2026 ' + String(23 - Math.floor(index / 60)).padStart(2, '0')
        + ':' + String(59 - index % 60).padStart(2, '0')); $('.event').last().before(row);
    }
    const result = parseCityAirExpress($.html(), NUMBER);
    expect(result.events).toHaveLength(100); expect(result.history_truncated).toBe(true);
    $('.event').last().find('.event-time').text('bad tail clock');
    expect(() => parseCityAirExpress($.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const tooMany = load(fixture()); tooMany('.scrollable').append(first.toString().repeat(501));
    expect(() => parseCityAirExpress(tooMany.html(), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCityAirExpress(' '.repeat(MAX_BYTES + 1), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects changed row structure and browser verification separately', () => {
    expect(() => parseCityAirExpress(fixture().replace('event-date-time', 'event-other-time'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCityAirExpress('<title>Just a moment</title><div>verify you are human</div>', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
});

describe('City Air Express HTTP and recognition contract', () => {
  it('uses the exact current tenant, supplied transport and recorded direct step', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse());
    const tracker = new CityAirExpressTracker({ fetcher, userAgent: 'Supplied Agent' });
    await expect(tracker.fetch(' mn 846291 ')).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(TRACKING_BASE + NUMBER); expect(init?.redirect).toBe('manual');
    expect(init?.headers).toMatchObject({ 'User-Agent': 'Supplied Agent', 'Accept-Language': 'en-GB' });
    expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init?.body).toBeUndefined();
  });

  it('preserves the shared narrow gate and declares its matching HTTP preflight pattern', async () => {
    const meta = JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse());
    const factory = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    expect(recognitionAskedCarriers(NUMBER)).toContain('city-air-express');
    expect(meta.detection).toEqual([{ id: 'city-air-express-1', pattern: '^MN\\d{6}$', confidence: 'low' }]);
    const offered = new RegExp(meta.tracking.recognition.pattern);
    for (const value of [NUMBER, 'MN846292']) expect(offered.test(value) && isCityAirExpressReference(value)).toBe(true);
    for (const value of ['MN8462910', 'BFS846291', 'MAN84629', '84629100', 'GB846291']) {
      expect(offered.test(value) || isCityAirExpressReference(value)).toBe(false);
      await expect(factory.recognize!(value)).resolves.toEqual({ known: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
    await expect(factory.recognize!(NUMBER)).resolves.toMatchObject({ known: true, lastActivityAt: null,
      lastActivityLocal: '2026-07-15T13:42:00' });
    expect(factory.steps).toEqual(['direct', 'retry']); expect(factory.recordsSteps).toBe(true);
  });

  it('keeps recognition absence, retained empty history and blocked lookup distinct', async () => {
    const tracker = new CityAirExpressTracker({ fetcher: vi.fn<typeof fetch>()
      .mockResolvedValueOnce(htmlResponse(unknown())).mockResolvedValueOnce(htmlResponse(empty()))
      .mockResolvedValueOnce(htmlResponse('', 403)) });
    await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: false });
    await expect(tracker.recognize(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null });
    await expect(tracker.recognize(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it.each([[301, 'transport'], [404, 'transport'], [410, 'transport'], [401, 'challenge'], [403, 'challenge'],
    [428, 'challenge'], [500, 'indeterminate']] as const)('does not retry HTTP %s or turn it into absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('Route unavailable', status));
    await expect(new CityAirExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves rate-limit timing and does not retry malformed data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(htmlResponse('', 429, { 'Retry-After': '9' }))
      .mockResolvedValueOnce(htmlResponse('Last unit does not have enough valid bits'));
    await expect(new CityAirExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 9000 });
    await expect(new CityAirExpressTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects unrelated response routes and oversized or non-HTML replies', async () => {
    const other = htmlResponse();
    Object.defineProperty(other, 'url', { value: 'https://unrelated.example.invalid/' });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(other)
      .mockResolvedValueOnce(new Response('{}', { headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(htmlResponse('x'.repeat(MAX_BYTES + 1)));
    const tracker = new CityAirExpressTracker({ fetcher });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ reason: 'response_too_large' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retries one network failure but uses no network for invalid/unsupported input', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('network unavailable')).mockResolvedValue(htmlResponse());
    await expect(new CityAirExpressTracker({ fetcher }).fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockClear();
    await expect(new CityAirExpressTracker({ fetcher }).fetch('BFS846291')).rejects.toMatchObject({ reason: 'unsupported_reference' });
    await expect(new CityAirExpressTracker({ fetcher }).fetch('../waybill')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(() => normalizeCityAirExpressNumber('MN846291-001')).toThrow(expect.objectContaining({ reason: 'unsupported_reference' }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes cancellation to an in-flight request and makes no retry', async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); ready();
    }));
    const result = new CityAirExpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal });
    await started; controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(result).rejects.toBeDefined(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });
});

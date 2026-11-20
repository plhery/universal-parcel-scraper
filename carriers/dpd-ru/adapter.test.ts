import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CARRIERS, carrierAdapter } from '../../core/catalog/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NoHistoryError, UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, DPD_RU_SEARCH, DPD_RU_SEARCH_AGAIN, DpdRuTracker } from './adapter.js';
import { dpdRuRequestNumber } from './number.js';
import { parseDpdRu } from './parser.js';
import { dpdRuStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Two public numbers, a Russian order handed on to its return and a Belarusian one in transit,
// a synthetic delivered order, and a number the tracker holds nothing for.
const REDIRECTED = 'RU122966215';
const IN_TRANSIT = 'BY123186908';
const DELIVERED = 'RU000000017';
const UNKNOWN = 'RU999999990';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => answer());
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('DPD Russia HTTP adapter', () => {
  it('posts the one number to the tracker’s search, through the supplied transport', async () => {
    const fetcher = answering(() => html(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new DpdRuTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${IN_TRANSIT.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(DPD_RU_SEARCH);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `orderNum=${IN_TRANSIT}&orderId=`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpd-ru', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an order in transit newest first, by day, with its terminals, estimate, service, weight and destination', () => {
    const result = parseDpdRu(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Принят на транзитном терминале', last_update: null, last_update_local: '2026-11-20',
      expected_delivery: '2026-11-23', service_name: 'DPD OPTIMUM', weight_kg: 0.44, receiver_address: 'Минск',
    });
    expect(result.events).toHaveLength(9);
    expect(result.events![0]).toEqual({ local_time: '2026-11-20', description: 'Принят на транзитном терминале', location: 'Москва',
      original_description: 'Принят на транзитном терминале (Москва)', stage: 'in_transit', stage_source: 'carrier_map' });
    // Rows of one day keep the tracker's order, newest first.
    expect(result.events!.slice(1, 3).map((event) => event.description)).toEqual(['Покинул транзитный терминал', 'Принят на транзитном терминале']);
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-10-27', description: 'Заказ создан, ожидаем груз от отправителя',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(result.events!.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit',
      'in_transit', 'accepted', 'registered', 'registered']);
  });

  it('reads an order handed on to its return as returned, without an estimate', () => {
    const result = parseDpdRu(fixture('redirected'), REDIRECTED);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_status_text: 'Доставка по другому заказу',
      last_update_local: '2026-10-26', expected_delivery: null, service_name: 'DPD Оптимум', weight_kg: 43.5 });
    expect(result.events![0]).toMatchObject({ location: 'Новокузнецк', stage: 'returned' });
    expect(result.events).toHaveLength(10);
    // Without a return named in the current status, the wording alone is an exception.
    const unnamed = parseDpdRu(fixture('redirected').replace(/Возврат осуществляется по номеру RU123121225/, 'Подробнее'), REDIRECTED);
    expect(unnamed).toMatchObject({ current_stage: 'exception' });
    // The client's order number is not kept.
    expect(JSON.stringify(result)).not.toContain('210-1320245');
  });

  it('reads a delivery with the clock of the delivered parcels’ table, and keeps no recipient', () => {
    const result = parseDpdRu(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Доставлен',
      last_update: null, last_update_local: '2026-11-02T15:13:00', expected_delivery: null });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events![0]).toMatchObject({ local_time: '2026-11-02T15:13:00', description: 'Доставлен', location: 'Казань' });
    expect(result.events!.find((event) => event.description === 'Возврат с маршрута в связи с отказом получателя'))
      .toMatchObject({ stage: 'failed_attempt' });
    expect(JSON.stringify(result)).not.toContain('А*******');
    // A delivered parcels' table of another day leaves the history's day.
    const later = parseDpdRu(fixture('delivered').replace('02.11.2026 15:13', '03.11.2026 09:00'), DELIVERED);
    expect(later.events![0]!.local_time).toBe('2026-11-02');
  });

  it('keeps a wording no rule reads without a stage, and an empty history as no history', () => {
    const unread = parseDpdRu(fixture('in-transit').replace('<td>Принят на транзитном терминале (Москва)</td>', '<td>Xyzzy (Москва)</td>'), IN_TRANSIT);
    expect(unread.events![0]).toEqual({ local_time: '2026-11-20', description: 'Xyzzy', location: 'Москва',
      original_description: 'Xyzzy (Москва)' });
    expect(unread).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Xyzzy' });
    const empty = fixture('in-transit').replace(/(<table class="module_table hide" id="trackHistory">)[\s\S]*?<\/table>/, '$1</table>');
    expect(() => parseDpdRu(empty, IN_TRANSIT)).toThrow(NoHistoryError);
  });

  it('reads the notice for an unknown number as not found, and nothing else', async () => {
    expect(() => parseDpdRu(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDpdRu('Сервис временно недоступен', UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    await expect(carrier(answering(() => html(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('binds the answer to the whole number asked', () => {
    expect(() => parseDpdRu(fixture('in-transit'), 'BY123186909')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const swapped = fixture('in-transit').replace(`<td>${IN_TRANSIT}</td>`, '<td>BY123186909</td>');
    expect(() => parseDpdRu(swapped, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed answer or day, and reads a browser check as a challenge', () => {
    expect(() => parseDpdRu('<html><body><h1>DPD</h1></body></html>', IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const day of ['31.11.2026', '2026-11-20', '20.11.26', '20.11.2026 10:00']) {
      expect(() => parseDpdRu(fixture('in-transit').replace('<td>20.11.2026', `<td>${day}`), IN_TRANSIT), day)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseDpdRu(CHALLENGE, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing order', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: IN_TRANSIT });
    await expect(lookup(() => html(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('Too Many Requests', { status: 429, headers: { 'Retry-After': '60' } })))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://www.dpd.kz/' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks the Belarusian portal once when the Kazakh one cannot be reached', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(html(fixture('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new DpdRuTracker({ fetcher, recorder }).fetch(IN_TRANSIT, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([DPD_RU_SEARCH, DPD_RU_SEARCH_AGAIN]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: IN_TRANSIT }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('rejects numbers the network does not issue, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'RU12296621', 'RU1229662150', 'UA122966215', '1229662150', 'RU122966215RU', `${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: IN_TRANSIT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known number and an unknown one as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(html(fixture('in-transit'))).mockResolvedValueOnce(html(fixture('not-found')));
    await expect(carrier(fetcher).recognize!(IN_TRANSIT)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    await expect(carrier(fetcher).recognize!('RU1')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('answers a number filed under DPD Russia or DPD Belarus', async () => {
    expect(carrierAdapter('dpd-by')).toBe('dpd-ru');
    const fetcher = answering(() => html(fixture('in-transit')));
    for (const id of ['dpd-ru', 'dpd-by'] as const) {
      await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: IN_TRANSIT, carrier: id }, { budgetMs: 3000 }))
        .resolves.toMatchObject({ carrier: id, source: id, result: { current_stage: 'in_transit' } });
    }
  });
});

describe('DPD Russia numbers and links', () => {
  it('takes the number in upper case without spaces or dashes', () => {
    for (const number of [IN_TRANSIT, ` ${IN_TRANSIT} `, 'by123186908', 'BY-123-186-908']) expect(dpdRuRequestNumber(number)).toBe(IN_TRANSIT);
    for (const number of ['KZ001010001', '94520014362', '10150358MOW']) expect(dpdRuRequestNumber(number)).toBe(number);
  });

  it('claims no number, so recognition never offers DPD Russia or DPD Belarus', () => {
    for (const number of [REDIRECTED, IN_TRANSIT]) {
      expect(detectCarrierMatch(number).candidates).not.toContain('dpd-ru');
      expect(detectCarrierMatch(number).candidates).not.toContain('dpd-by');
      expect(recognitionCandidates(number).map(({ carrier: id }) => id)).not.toContain('dpd-ru');
    }
  });

  it('links to the tracking page for one number, and reads that page’s address back', () => {
    expect(CARRIERS['dpd-ru'].trackingUrl?.(REDIRECTED)).toBe(`https://mydpd.dpd.kz/ols/trace2/standard.do2?orderNum=${REDIRECTED}`);
    expect(CARRIERS['dpd-by'].trackingUrl?.(IN_TRANSIT)).toBe(`https://mydpd.dpd.by/ols/trace2/standard.do2?orderNum=${IN_TRANSIT}`);
    expect(parseTrackingInput(`https://www.dpd.ru/ols/trace2/standard.do2?orderNum=${REDIRECTED}`))
      .toMatchObject({ trackingNumber: REDIRECTED, carrier: 'dpd-ru' });
    expect(parseTrackingInput(`https://mydpd.dpd.by/ols/trace2/standard.do2?orderNum=${IN_TRANSIT}`))
      .toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'dpd-by' });
  });
});

describe('DPD Russia status vocabulary', () => {
  it('stages every recorded wording as the map does', () => {
    for (const entry of statuses.entries as { wording: string; stage: string }[]) {
      expect(dpdRuStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'dpd-ru', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('DELIVERED', 'Доставлен')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'dpd-ru', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});

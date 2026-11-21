import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { adapter, AP_CARGO_API, AP_CARGO_LEGACY_API, ApCargoTracker } from './adapter.js';
import { normalizeApCargoNumber, parseApCargo } from './parser.js';
import { apCargoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples of numbers.json the fixtures answer, and a made-up number.
const OUT_FOR_DELIVERY = '47529414';
const RECEIVED = '50479601';
const UNKNOWN = '93017264';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string): Record<string, unknown> => JSON.parse(text(name)) as Record<string, unknown>;
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const isLegacy = (url: unknown) => String(url).startsWith(AP_CARGO_LEGACY_API);
// The two trackers' replies, as each answers the lookup.
const trackers = (lambda: () => Response | Promise<Response>, legacy: () => Response | Promise<Response> = () => reply(text('legacy-not-found'))) =>
  vi.fn<typeof fetch>().mockImplementation(async (url) => (isLegacy(url) ? legacy() : lambda()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const row = (Status: unknown, DateTime: unknown = '2026-04-30T10:50:22', Location: unknown = '') =>
  ({ Id: 1, DateTime, DateString: 'April 30, 2026', Status, Location });
const record = (rows: unknown[], patch: Record<string, unknown> = {}) =>
  ({ ...fixture('out-for-delivery'), Items: [{ Date: 'April 30, 2026', DeliveryStatus: rows }], ...patch });
const legacyDelivery = (DateTime: string, Airwaybill = OUT_FOR_DELIVERY) =>
  ({ ...fixture('legacy-delivered'), Airwaybill, Items: [{ Date: 'Synthetic', DeliveryStatus: [row('Delivered', DateTime, 'Sampletown')] }] });

describe('AP Cargo HTTP adapter', () => {
  it('asks both trackers for the whole number once, through the supplied transport', async () => {
    const fetcher = trackers(() => reply(text('received')), () => reply(text('legacy-received')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new ApCargoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 5047-9601 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `${AP_CARGO_LEGACY_API}?airwaybill=${RECEIVED}`, `${AP_CARGO_API}?waybillNumber=${RECEIVED}`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
        headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ap-cargo', step: 'direct', outcome: 'ok' }));
  });

  it('reads a received waybill newest first on branch wall clocks, with the names the page shows', async () => {
    const result = await carrier(trackers(() => reply(text('received')), () => reply(text('legacy-received')))).track({ number: RECEIVED });
    expect(result).toEqual(expect.objectContaining({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Received', last_update: null, last_update_local: '2026-10-09T13:02:23', expected_delivery: null,
      sender_name: 'PREZ, JOHN ROBERT', receiver_name: 'MORTILLAS, ROY',
    }));
    // The tracker's own delivery stands: the older tracker's is not added.
    expect(result.events).toEqual([
      { local_time: '2026-10-09T13:02:23', description: 'Received', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-10-05T09:33:31', location: 'PAGADIAN BRANCH', description: 'Arrived at Destination Branch', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-10-03T06:54:48', location: 'PAGADIAN BRANCH', description: 'In-Transit (Transferred to Branch)', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-10-02T09:23:30', description: 'In-Transit', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-09-29T21:15:37', description: 'In-Transit', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-09-29T18:28:26', location: 'MCO BRANCH', description: 'Arrived at Origin Sorting Hub', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2026-09-29T14:47:13', description: 'Successfully Accepted', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
  });

  it('adds the older tracker’s delivery to a history that stops at the delivery round, dated by its day', async () => {
    const result = await carrier(trackers(() => reply(text('out-for-delivery')), () => reply(text('legacy-delivered')))).track({ number: OUT_FOR_DELIVERY });
    expect(result).toEqual(expect.objectContaining({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update: null, last_update_local: '2026-04-30',
      sender_name: 'JASON, APAO', receiver_name: 'JECKY, NOLON',
    }));
    expect(result.events!.map(({ local_time, location, description }) => [local_time, location, description])).toEqual([
      ['2026-04-30', 'Tacurong', 'Delivered'],
      ['2026-04-30T10:50:22', undefined, 'Out for Delivery'],
      ['2026-04-30T10:40:20', 'TACURONG BRANCH', 'Arrived at Transport Hub'],
      ['2026-04-30T09:37:34', 'TACURONG BRANCH', 'In-Transit (Transferred to Branch)'],
      ['2026-04-30T08:26:53', 'MARBEL BRANCH', 'Arrived at Destination Branch'],
      ['2026-04-29T12:07:24', 'MARBEL BRANCH', 'In-Transit (Transferred to Branch)'],
      ['2026-04-29T11:21:13', 'GENERAL SANTOS BRANCH', 'In Transit to Destination Branch'],
      ['2026-04-29T11:14:11', 'GENERAL SANTOS BRANCH', 'Arrived at Destination Gateway'],
      ['2026-04-27T21:45:58', undefined, 'In-Transit'],
      ['2026-04-27T21:23:46', 'MCO BRANCH', 'Arrived at Origin Sorting Hub'],
      ['2026-04-27T16:46:51', undefined, 'Successfully Accepted'],
    ]);
    expect(result.events![1]).toMatchObject({ stage: 'out_for_delivery', stage_source: 'carrier_map' });
  });

  it('keeps the tracker’s answer alone when the older tracker names another number, an earlier day, or fails', async () => {
    const outForDelivery = { status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Out for Delivery', last_update_local: '2026-04-30T10:50:22' };
    for (const legacy of [
      () => reply(text('legacy-received')), () => reply(text('legacy-not-found')),
      () => reply(JSON.stringify(legacyDelivery('2026-04-29T00:00:00'))), () => reply(JSON.stringify(legacyDelivery('2026-04-30T00:00:00', RECEIVED))),
      () => reply(JSON.stringify({ ...fixture('legacy-delivered'), Items: [{ DeliveryStatus: [row(7)] }] })),
      () => reply('<html><body>Server Error</body></html>', { status: 500 }), () => reply(CHALLENGE), () => Promise.reject(new TypeError('fetch failed')),
    ]) {
      const result = await carrier(trackers(() => reply(text('out-for-delivery')), legacy)).track({ number: OUT_FOR_DELIVERY });
      expect(result).toMatchObject(outForDelivery);
      expect(result.events).toHaveLength(10);
    }
    // A delivery the older tracker gives a later day comes first.
    const later = parseApCargo(fixture('out-for-delivery'), OUT_FOR_DELIVERY, legacyDelivery('2026-05-02T00:00:00'));
    expect(later.events![0]).toEqual({ local_time: '2026-05-02', location: 'Sampletown', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads the tracker’s wrapped 404 around an empty record as not found, whatever the older tracker says', async () => {
    await expect(carrier(trackers(() => reply(text('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(trackers(() => reply(text('not-found')), () => reply(text('legacy-delivered')))).track({ number: OUT_FOR_DELIVERY }))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseApCargo(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('keeps other wrapped answers, and records without a waybill, apart from a missing parcel', () => {
    const wrapped = (statusCode: unknown, body: unknown = fixture('not-found').body, success: unknown = false) => ({ success, statusCode, body });
    expect(() => parseApCargo(wrapped(429), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseApCargo(wrapped(500, '{"message":"Internal server error"}'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate', status: 500 }));
    for (const payload of [
      wrapped(404, '{"message":"Not Found"}'), wrapped(404, ''), wrapped(404, JSON.stringify({ ...fixture('legacy-not-found'), Airwaybill: 'X' })),
      wrapped(200, text('received'), true), wrapped('404'), { success: false },
      // The older tracker's empty record, unwrapped, is not the tracker's answer.
      fixture('legacy-not-found'), {}, null, 'text', [],
    ]) expect(() => parseApCargo(payload, UNKNOWN), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses a malformed history, and reads a waybill without rows as listed without history', () => {
    for (const payload of [
      record([row(7)]), record([row(' ')]), record([null]), record([row('In-Transit', '2026-04-30T10:50:22', 12)]),
      record([row('In-Transit', null)].map((entry) => ({ ...entry, DateString: null }))),
      { ...record([]), Items: 'none' }, { ...record([]), Items: [null] }, { ...record([]), Items: [{ Date: 'April 30, 2026' }] },
      record(Array.from({ length: 501 }, () => row('In-Transit'))),
    ]) expect(() => parseApCargo(payload, OUT_FOR_DELIVERY), JSON.stringify(payload).slice(0, 120)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [record([]), { ...record([]), Items: null }, { ...record([]), Items: [] }]) {
      expect(() => parseApCargo(payload, OUT_FOR_DELIVERY)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
    }
  });

  it('keeps wall clocks without a zone, reads midnight as a date, and keeps a clock it cannot read as text', () => {
    const events = parseApCargo(record([
      row('Arrived at Destination Branch', '2026-04-30T09:00:00.123', 'SAMPLE BRANCH'), row('In-Transit', '2026-04-29T00:00:00'),
      row('In-Transit', '2026-02-30T10:00:00'), row('In-Transit', '2026-04-28T24:00:00'), row('In-Transit', '2026-04-28T08:00:00Z'),
      { ...row('In-Transit', null), DateString: 'April 27, 2026' },
    ]), OUT_FOR_DELIVERY).events!;
    expect(events.map(({ local_time, provider_time_text }) => local_time ?? `text:${String(provider_time_text)}`)).toEqual([
      '2026-04-30T09:00:00', '2026-04-29',
      'text:2026-02-30T10:00:00', 'text:2026-04-28T24:00:00', 'text:2026-04-28T08:00:00Z', 'text:April 27, 2026',
    ]);
    expect(events.some((event) => 'time' in event)).toBe(false);
    // Rows of one clock keep the tracker's order, newest first.
    const same = parseApCargo(record([row('Out for Delivery'), row('Arrived at Transport Hub')]), OUT_FOR_DELIVERY).events!;
    expect(same.map((event) => event.description)).toEqual(['Out for Delivery', 'Arrived at Transport Hub']);
  });

  it('keeps blocks, rate limits and moved routes apart from a missing parcel', async () => {
    const lookup = (answer: () => Response) => carrier(trackers(answer)).track({ number: OUT_FOR_DELIVERY });
    await expect(lookup(() => reply(CHALLENGE, { headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply(CHALLENGE, { status: 404, headers: { 'Content-Type': 'text/html' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('{"message":"Forbidden"}', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => reply('{"message":"Too Many Requests"}', { status: 429, headers: { 'Retry-After': '120' } })))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    // API Gateway's answer for a route it does not have is a moved route, as are a redirect and an HTTP 404 or 410.
    await expect(lookup(() => reply('{"message":"Missing Authentication Token"}', { status: 403 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 301, headers: { Location: 'https://apcargo.com.ph/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('{"message":"Not Found"}', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('', { status: 410 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => reply('<html><body>Internal Server Error</body></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply(''))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => reply('{"message":"Internal server error"}', { status: 502 }))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(() => reply('', { status: 503 }))).rejects.toMatchObject({ kind: 'maintenance' });
  });

  it('asks once more when AP Cargo cannot be reached, inside the caller’s budget', async () => {
    const lambda = vi.fn<() => Promise<Response>>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('received')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new ApCargoTracker({ fetcher: trackers(lambda), recorder }).fetch(RECEIVED, { budgetMs: 2000 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(lambda).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: RECEIVED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing.mock.calls.filter(([url]) => !isLegacy(url))).toHaveLength(2);
  });

  it('ends a hanging read inside the budget', async () => {
    const clock = fakeBudgetClock();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const started = Date.now();
    await clock.settle(expect(carrier(fetcher).track({ number: RECEIVED }, { budgetMs: 80 })).rejects.toThrow());
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects what is not an AP Cargo waybill number, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '5047960', '504796010', 'A5047960', 'BMB075AA2202191PH', '5'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: RECEIVED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeApCargoNumber(' 5047 9601 ')).toBe(RECEIVED);
    expect(normalizeApCargoNumber('5047-9601')).toBe(RECEIVED);
  });

  it('maps every wording statuses.json records to its stage', () => {
    const entries = statuses.entries as { wording: string; stage: string }[];
    expect(entries.length).toBeGreaterThan(0);
    for (const { wording, stage } of entries) {
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
      expect(apCargoStage(wording), wording).toEqual({ stage, source: 'carrier_map' });
    }
    expect(statusMap.stage(null, normalizeStatusWording('ACCEPTED AT MANILA'))).toBe('accepted');
    expect(statusMap.stage(null, normalizeStatusWording('ARRIVED AT CEBU'))).toBe('in_transit');
    expect(statusMap.stage(null, 'xyzzy')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});

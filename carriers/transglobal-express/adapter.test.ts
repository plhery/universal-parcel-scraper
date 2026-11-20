import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError, SchemaError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, normalizeTransglobalReference, parseTransglobal, TransglobalTracker, transglobalPageUrl, transglobalResultUrl } from './adapter.js';
import { transglobalMappedStage, transglobalStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import evri from './fixtures/reference-10685786.json' with { type: 'json' };
import spring from './fixtures/reference-10681936.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };

type Page = typeof evri;
const REFERENCE = 'TP-10685786';
const RESULT = transglobalResultUrl();
const copy = (): Page => structuredClone(evri);
const capture = (data: unknown = evri, extra: Record<string, unknown> = {}) => ({ url: RESULT, status: 200, trackingNumberSubmitted: 'TP10685786',
  headers: {}, body: JSON.stringify(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'transglobal-reply', url = transglobalPageUrl(REFERENCE), statusCode = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url, html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new TransglobalTracker(environment) };
}

describe('Transglobal Express tracker', () => {
  it('reads a collection by Transglobal and Evri’s rows on their wall clocks', () => {
    const result = parseTransglobal(evri);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: "We're unable to deliver this parcel today. We will now deliver the next working day",
      last_update: null, last_update_local: '2026-10-23T08:34:00', expected_delivery: null,
      delivery_carrier: 'evri-uk', delivery_tracking_number: 'H01I0A0009098020' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result.events!.map(({ local_time, stage }) => [local_time, stage])).toEqual([
      ['2026-10-23T08:34:00', 'in_transit'], ['2026-10-23T08:33:00', 'in_transit'],
      ['2026-10-22T23:39:00', 'in_transit'], ['2026-10-22T22:44:00', 'in_transit'], ['2026-10-22T20:40:00', 'in_transit'],
      ['2026-10-21T08:51:00', 'in_transit'], ['2026-10-21T08:51:00', 'in_transit'], ['2026-10-21T03:03:00', 'in_transit'],
      ['2026-10-20T22:58:00', 'in_transit'], ['2026-10-20T22:57:00', 'in_transit'], ['2026-10-20T15:53:00', 'in_transit'],
      ['2026-10-20T12:36:00', 'accepted'], ['2026-10-20T10:28:00', 'registered'],
    ]);
    // The depot is a place; the booking's and the collection's states in the same column are not.
    expect(result.events![10]).toEqual({ local_time: '2026-10-20T15:53:00', description: 'Processed at Origin Depot',
      location: 'Transglobal (Wirral)', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events![11]).toEqual({ local_time: '2026-10-20T12:36:00', description: 'Collected by Marty (Transglobal)',
      stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events![12]).not.toHaveProperty('location');
    expect(result.events!.some((event) => 'time' in event)).toBe(false);
    expect(normalizeCarrierResult(result)).toMatchObject({ delivery_carrier: 'evri-uk', delivery_tracking_number: 'H01I0A0009098020' });
  });

  it('reads a booking for drop-off with Spring as the partner', () => {
    expect(parseTransglobal(spring)).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'PARCEL CREATED',
      last_update_local: '2026-10-19T13:11:00', delivery_carrier: 'spring-gds', delivery_tracking_number: 'LX112076891NL',
      events: [{ local_time: '2026-10-19T13:11:00', description: 'PARCEL CREATED', stage: 'registered' },
        { local_time: '2026-10-19T13:11:00', description: 'Booking Made', stage: 'registered' }] });
  });

  it('stages a row the map does not know by the shared wording rules, and names only a known partner', () => {
    // Invented: Evri's delivery after the fixture's rows, and a leg with another partner.
    const page = copy();
    page.days.unshift({ date: 'Saturday, October 24, 2026', rows: [{ time: '12:05', description: 'Your parcel has been delivered', location: '' }] });
    page.legs = [{ name: 'Courier (Main)', number: 'ABC123456' }];
    const result = parseTransglobal(page);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'wording:language',
      delivery_tracking_number: 'ABC123456' });
    expect(result).not.toHaveProperty('delivery_carrier');
    page.legs = [{ name: 'Evri (Collection)', number: 'H01I0A0009098020' }, { name: 'Evri (Main)', number: 'not a number' }];
    expect(parseTransglobal(page)).not.toHaveProperty('delivery_tracking_number');
    page.days = [{ date: 'Saturday, October 24, 2026', rows: [{ time: '12:05', description: 'Something new happened', location: '' }] }];
    expect(parseTransglobal(page)).toMatchObject({ status: 'unknown', last_status_text: 'Something new happened' });
    expect(parseTransglobal(page)).not.toHaveProperty('current_stage');
  });

  it('keeps a repeated row once and lists the day’s rows newest first', () => {
    const page = copy();
    page.days[0]!.rows.push(page.days[0]!.rows[1]!);
    expect(parseTransglobal(page).events).toHaveLength(13);
  });

  it('reads an unknown reference as not found and an order without rows as listed', () => {
    expect(() => parseTransglobal(unknown)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    let error: unknown;
    try { parseTransglobal({ ...copy(), days: [] }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(NoHistoryError);
    expect(error).toMatchObject({ reason: 'listed', deliveryCarrier: 'evri-uk', deliveryTrackingNumber: 'H01I0A0009098020' });
    expect(() => parseTransglobal({ kind: 'history', legs: [], days: [] })).toThrow(NoHistoryError);
  });

  it('refuses an answer it cannot read', () => {
    const broken = (edit: (page: Record<string, unknown>) => void) => { const page = copy() as unknown as Record<string, unknown>; edit(page); return page; };
    for (const body of [null, { kind: 'unconfirmed' }, { kind: 'schema' }, broken((page) => { page.days = null; }),
      broken((page) => { page.legs = 'Evri'; }), broken((page) => { page.days = Array(201).fill({ date: 'Friday, October 23, 2026', rows: [] }); }),
      broken((page) => { page.days = [{ date: 'Friday, October 23, 2026', rows: Array(501).fill(evri.days[0]!.rows[0]) }]; })]) {
      expect(() => parseTransglobal(body), JSON.stringify(body)?.slice(0, 80)).toThrow(SchemaError);
    }
    // A heading whose weekday is not its date's, a day that does not exist, a clock past midnight.
    for (const [date, time] of [['Thursday, October 23, 2026', '08:34'], ['Friday, February 30, 2026', '08:34'], ['23/10/26', '08:34'],
      ['Friday, October 23, 2026', '24:00'], ['Friday, October 23, 2026', '8.34']]) {
      const page = copy();
      page.days = [{ date: date!, rows: [{ time: time!, description: 'Parcel processed at the depot', location: '' }] }];
      expect(() => parseTransglobal(page), `${date} ${time}`).toThrow(SchemaError);
    }
    const page = copy();
    page.days = [{ date: 'Friday, October 23, 2026', rows: [{ time: '08:34', description: ' ', location: '' }] }];
    expect(() => parseTransglobal(page)).toThrow(SchemaError);
  });

  it('takes a TP reference whole and refuses anything else before asking', async () => {
    expect(normalizeTransglobalReference('TP10685786')).toBe(REFERENCE);
    expect(normalizeTransglobalReference(' tp-10685786 ')).toBe(REFERENCE);
    const h = harness();
    for (const number of ['10685786', 'TP-01068578', 'TP-1234', 'TP-1234567890', 'TX-10685786', 'H01I0A0009098020', '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('transglobal-express');
  });

  it('asks the browser service for the form and the bound result page', async () => {
    const h = harness();
    await expect(h.tracker.fetch('TP10685786')).resolves.toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-10-23T08:34:00' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: 'https://www.transglobalexpress.co.uk/track-shipment/?reference=TP-10685786', skipHttp: true, maxTier: 3, captureResponses: [RESULT] });
    expect(adapter(h.environment)).toMatchObject({ id: 'transglobal-express', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(REFERENCE, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(REFERENCE, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads the helper’s answers as what they are', async () => {
    await expect(harness([capture(unknown)]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture(null, { body: '', error: 'challenge-html' })]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 403, body: '' })]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 302, body: null, error: 'unexpected-redirect' })]).tracker.fetch(REFERENCE))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(harness([capture(null, { status: 429, body: '', headers: { 'retry-after': '60' } })]).tracker.fetch(REFERENCE))
      .rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture(null, { status: 502, body: '' })]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'indeterminate', status: 502 });
    await expect(harness([capture(evri, { trackingNumberSubmitted: 'TP10685787' })]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(), capture()]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(evri, { truncated: true })]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(evri, { body: null, error: 'capture-incomplete' })]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { body: '<html>' })]).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture()], 'transglobal-reply', 'https://www.transglobalexpress.co.uk/').tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 'transglobal-verification').tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'transglobal-navigation', undefined, 403).tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'transglobal-capture_missing').tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'transglobal-runtime').tracker.fetch(REFERENCE)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new TransglobalTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(REFERENCE))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps every wording it has seen', () => {
    for (const entry of statuses.entries) {
      expect(transglobalMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'transglobal-express', description: entry.wording }), entry.wording)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
    expect(transglobalMappedStage('Collected by Sam (Transglobal) again')).toBeUndefined();
    expect(transglobalStage('Something new happened')).toBeNull();
  });
});

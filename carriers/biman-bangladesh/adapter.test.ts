import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, RateLimitedError, SchemaError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, BIMAN, FREIGHT_AERO_LOOKUP, freightAeroPageUrl, freightAeroWaybill, FreightAeroTracker, parseFreightAero } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import sample from './fixtures/awb-99767220602.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
type Event = (typeof sample)[number]['events'][number];
const body = (data: unknown) => JSON.stringify(data);
/** The sample with only the events this keeps. */
const only = (keep: (event: Event) => boolean, edit: (row: (typeof sample)[number]) => void = () => {}) => {
  const reply = structuredClone(sample);
  reply[0]!.events = reply[0]!.events.filter(keep);
  edit(reply[0]!);
  return body(reply);
};
const capture = (data: unknown = sample, extra: Record<string, unknown> = {}) => ({ url: FREIGHT_AERO_LOOKUP, status: 200,
  trackingNumberSubmitted: NUMBER.replace('-', ''), headers: {}, body: body(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'freight-aero-reply', url = freightAeroPageUrl(NUMBER), statusCode = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url, html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new FreightAeroTracker(environment, BIMAN) };
}

describe('Biman Bangladesh Airlines tracker', () => {
  it('reads a shipment from Dhaka delivered in three parts at Toronto', () => {
    const result = parseFreightAero(body(sample), NUMBER, BIMAN);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Part shipment of 128 pieces at 218.0 KG has been delivered at Toronto (YYZ).',
      last_update: null, last_update_local: '2026-01-19T16:06:00', expected_delivery: null });
    const events = result.events!;
    // Two of the tracker's events repeat another's clock, sentence and place.
    expect(events).toHaveLength(sample[0]!.events.length - 2);
    expect(events[0]).toEqual({ local_time: '2026-01-19T16:06:00', provider_code: 'Delivered', stage: 'delivered', stage_source: 'carrier_map',
      description: 'Part shipment of 128 pieces at 218.0 KG has been delivered at Toronto (YYZ).', location: 'Toronto (YYZ)' });
    expect(events.at(-1)).toMatchObject({ local_time: '2026-01-11T19:24:00', provider_code: 'Booked', stage: 'registered',
      location: 'Dhaka Hazrat Shahjalal (DAC)' });
    expect(events.find((event) => event.provider_code === 'Received from shipper')).toEqual({ local_time: '2026-01-12T16:56:00',
      provider_code: 'Received from shipper', stage: 'accepted', stage_source: 'carrier_map',
      description: 'Total shipment of 1228 pieces at 2396.0 KG received from shipper.' });
    expect(events.find((event) => event.provider_code === 'Arrived')?.description)
      .toBe('Part shipment of 128 pieces at 218.0 KG arrived on flight BG305 / 17JAN26 at Toronto (YYZ).');
    // Each station's own clock, and no instant the reply does not give.
    expect(events.every((event) => !('time' in event) && !/[<>]/.test(event.description!))).toBe(true);
    expect(normalizeCarrierResult(result).events).toHaveLength(events.length);
  });

  it('files a booking by its place: before receipt, before the first departure, and after it', () => {
    const events = parseFreightAero(body(sample), NUMBER, BIMAN).events!;
    const stage = (sequence: number) => {
      const source = sample[0]!.events.find((event) => event.eventSequenceNumber === sequence)!;
      const sentence = source.detail.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,;:])/g, '$1').trim();
      return events.find((event) => event.description === sentence && event.local_time?.slice(11, 16) === source.eventTime.slice(-5))?.stage;
    };
    expect([6, 8, 9, 14, 31].map(stage)).toEqual(['registered', 'accepted', 'accepted', 'in_transit', 'in_transit']);
  });

  it('delivers a waybill delivered in parts only once every piece is', () => {
    // The sample as it stood before its last part flew: two parts of three delivered.
    const early = parseFreightAero(only((event) => event.eventSequenceNumber <= 41), NUMBER, BIMAN);
    expect(early).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'Part shipment of 707 pieces at 1476.0 KG has been delivered at Toronto (YYZ).' });
    expect(early.events![0]).toMatchObject({ provider_code: 'Delivered', stage: 'delivered' });
    // Invented: the whole shipment delivered at once.
    const whole = only((event) => event.eventSequenceNumber <= 41, (row) => {
      row.events.at(-1)!.detail = 'Total shipment of 1228 pieces at 2396.0 KG has been <b>delivered</b> at <b>Toronto (YYZ)</b>.';
    });
    expect(parseFreightAero(whole, NUMBER, BIMAN)).toMatchObject({ current_stage: 'delivered' });
    // Without a count, a delivery delivers.
    const uncounted = only((event) => event.eventSequenceNumber <= 41, (row) => { (row as { totalPieces: unknown }).totalPieces = null; });
    expect(parseFreightAero(uncounted, NUMBER, BIMAN)).toMatchObject({ current_stage: 'ready_for_pickup' });
  });

  it('keeps an unknown waybill, a refusal and an unreadable reply apart', () => {
    expect(() => parseFreightAero(body(unknown), '997-00000001', BIMAN)).toThrow(NotFoundError);
    expect(() => parseFreightAero(body([{ ...unknown[0], responseCode: 'ERROR' }]), '997-00000001', BIMAN)).toThrow(IndeterminateError);
    expect(() => parseFreightAero(body(unknown), NUMBER, BIMAN)).toThrow(IndeterminateError);
    expect(() => parseFreightAero(body([{ ...sample[0], carrier: 'PK' }]), NUMBER, BIMAN)).toThrow(IndeterminateError);
    expect(() => parseFreightAero(body({ error: 'Too many requests' }), NUMBER, BIMAN)).toThrow(RateLimitedError);
    expect(() => parseFreightAero(body([{ ...sample[0], events: null }]), NUMBER, BIMAN)).toThrow(NoHistoryError);
    expect(() => parseFreightAero(body([{ ...sample[0], events: [] }]), NUMBER, BIMAN)).toThrow(NoHistoryError);
    for (const reply of ['nope', body({}), body([]), body([sample[0], sample[0]]), body([{ ...sample[0], responseCode: 'MAYBE' }]),
      body([{ ...sample[0], events: {} }]), body([{ ...sample[0], events: Array.from({ length: 501 }, () => sample[0]!.events[0]) }]),
      only(() => true, (row) => { row.events[0]!.eventTime = '31-Feb-2026 10:00'; }),
      only(() => true, (row) => { row.events[0]!.eventTime = '2026-01-11T19:24'; }),
      only(() => true, (row) => { row.events[0]!.status = ''; }),
      only(() => true, (row) => { (row.events[0] as { eventSequenceNumber: unknown }).eventSequenceNumber = '1'; })]) {
      expect(() => parseFreightAero(reply, NUMBER, BIMAN), reply.slice(0, 60)).toThrow(SchemaError);
    }
  });

  it('takes the waybill with or without its prefix, and refuses a wrong check digit or another airline before asking', async () => {
    const [prefix, serial] = NUMBER.split('-') as [string, string];
    for (const raw of [NUMBER, `${prefix}${serial}`, ` ${prefix} ${serial.slice(0, 4)} ${serial.slice(4)} `, serial]) {
      expect(freightAeroWaybill(raw, BIMAN), raw).toBe(NUMBER);
    }
    const h = harness();
    for (const raw of [`${prefix}-${serial.slice(0, 7)}${(Number(serial[7]) + 1) % 10}`, `014-${serial}`, serial.slice(0, 7), `${serial}0`, 'BG-12345675', '']) {
      await expect(h.tracker.fetch(raw), raw).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).carrier, record.number).not.toBe('biman-bangladesh');
  });

  it('asks the browser service to open the tracker for the whole waybill and capture its lookup', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER.replace('-', ''))).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: `https://www.freight.aero/tracking.asp#${NUMBER}`, skipHttp: true, maxTier: 3,
      captureResponses: ['https://www.freight.aero/tracking_service.asp?uuid=&is_portlet=0'] });
    expect(adapter(h.environment)).toMatchObject({ id: 'biman-bangladesh', steps: ['trawl'] });
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads a kept reCAPTCHA as a challenge and other answers as what they are', async () => {
    const fetch = (...args: Parameters<typeof harness>) => harness(...args).tracker.fetch(NUMBER);
    await expect(fetch([capture(unknown)])).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(fetch([capture({ error: 'Too many requests' })])).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(fetch([capture(null, { body: null, error: 'challenge-html' })])).rejects.toMatchObject({ kind: 'challenge' });
    await expect(fetch([capture(null, { status: 403, body: '' })])).rejects.toMatchObject({ kind: 'challenge' });
    await expect(fetch([capture(null, { status: 429, body: '', headers: { 'Retry-After': '60' } })])).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    // A refused token and an outage get the same server error page.
    await expect(fetch([capture(null, { status: 500, body: '' })])).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    await expect(fetch([capture(null, { body: null, error: 'invalid-json' })])).rejects.toMatchObject({ kind: 'schema' });
    await expect(fetch([capture(null, { body: null, error: 'body-read' })])).rejects.toMatchObject({ kind: 'transport' });
    await expect(fetch([capture(sample, { truncated: true })])).rejects.toMatchObject({ kind: 'transport' });
    await expect(fetch([capture(sample, { trackingNumberSubmitted: '99767220613' })])).rejects.toMatchObject({ kind: 'schema' });
    await expect(fetch([capture(), capture()])).rejects.toMatchObject({ kind: 'schema' });
    await expect(fetch([capture()], 'freight-aero-reply', 'https://www.freight.aero/')).rejects.toMatchObject({ kind: 'schema' });
    await expect(fetch([], 'freight-aero-capture_missing')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(fetch([], 'freight-aero-capture_missing', freightAeroPageUrl(NUMBER), 403)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(fetch([], 'freight-aero-capture_missing', freightAeroPageUrl(NUMBER), 502)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(fetch([], 'freight-aero-airline_missing')).rejects.toMatchObject({ kind: 'schema' });
    await expect(fetch([], 'freight-aero-runtime')).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new FreightAeroTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }, BIMAN).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps every status it knows', () => {
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'biman-bangladesh', providerCode: entry.code, description: entry.wording }), entry.code)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
  });
});

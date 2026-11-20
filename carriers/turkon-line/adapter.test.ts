import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError, TransportError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, containerCheckDigit, parseTurkon, TurkonTracker, turkonLowerUrl, turkonPageUrl, turkonQuery } from './adapter.js';
import { turkonStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import sample from './fixtures/booking-10186118.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };
import twoContainers from './fixtures/synthetic-booking-two-containers.json' with { type: 'json' };

const BILL = numbers.records[0]!.number;
const BOOKING = { kind: 'booking', number: '10186118' } as const;
const SYNTHETIC = { kind: 'booking', number: '99999901' } as const;
const body = (data: unknown) => JSON.stringify(data);
const capture = (data: unknown = sample, extra: Record<string, unknown> = {}) => ({ url: turkonLowerUrl(BOOKING.number), status: 200,
  trackingNumberSubmitted: BOOKING.number, headers: {}, body: body(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'turkon-line-reply', url = turkonPageUrl(BOOKING.number), statusCode = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url, html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new TurkonTracker(environment) };
}

describe('Turkon Line tracker', () => {
  it('reads the public booking: one container from Ambarli to New York, returned empty', () => {
    const result = parseTurkon(body(sample), BOOKING);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'GATE IN EMPTY', last_update: null, last_update_local: '2025-05-06T14:05:00', expected_delivery: null });
    expect(result).not.toHaveProperty('planned_events');
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.stage])).toEqual([
      ['2025-05-06T14:05:00', 'GIE', 'delivered'],
      ['2025-05-05T17:17:00', 'GOF', 'out_for_delivery'],
      ['2025-05-02T09:30:00', 'DCF', 'in_transit'],
      ['2025-04-11T09:48:43', 'LDF', 'in_transit'],
      ['2025-04-08T18:00:02', 'GIF', 'accepted'],
      ['2025-04-08T17:59:34', 'GOE', 'registered'],
    ]);
    expect(result.events![5]).toEqual({ local_time: '2025-04-08T17:59:34', description: 'GATE OUT EMPTY', location: 'OZMARMARA, ISTANBUL-TR',
      provider_code: 'GOE', stage: 'registered', stage_source: 'carrier_map' });
  });

  it('keeps the moves still due apart, and the containers’ shared load once', () => {
    const result = parseTurkon(body(twoContainers), SYNTHETIC);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-03-04T10:00:00' });
    expect(result.events!.map((event) => [event.local_time, event.provider_code])).toEqual([
      ['2026-03-04T10:00:00', 'LDF'], ['2026-03-02T11:00:00', 'GIF'], ['2026-03-02T09:00:00', 'GIF'],
      ['2026-03-01T08:30:00', 'GOE'], ['2026-03-01T08:00:00', 'GOE'],
    ]);
    expect(normalizeCarrierResult(result).planned_events).toEqual([
      { local_time: '2026-03-20', description: 'FULL DISCHARGE', location: 'OTHER PORT, OTHER TOWN - TR', stage: 'in_transit' },
    ]);
  });

  it('waits for every container before it calls a booking delivered', () => {
    // Invented: the first container delivered and returned, the second still at sea.
    const reply = structuredClone(twoContainers);
    const [first] = reply.payload;
    first!.events = [...first!.events.slice(0, 3),
      { ...first!.events[3]!, eventSaat: '07:00:00', ekVeri3: '1' },
      { ...first!.events[3]!, eventCode: 'GOF', eventName: 'GATE OUT FULL', eventTarih: '21.03.2026', eventSaat: '09:00:00', ekVeri3: '1' },
      { ...first!.events[3]!, eventCode: 'GIE', eventName: 'GATE IN EMPTY', eventTarih: '24.03.2026', eventSaat: '15:00:00', ekVeri3: '2' }];
    expect(parseTurkon(body(reply), SYNTHETIC)).toMatchObject({ current_stage: 'in_transit', last_status_text: 'GATE IN EMPTY' });
    reply.payload[1]!.events = structuredClone(first!.events).map((event) => ({ ...event, containerNo: 'ZZZU0000012' }));
    expect(parseTurkon(body(reply), SYNTHETIC)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('reads a full gate-in after sailing as transit and an empty return before it as no stage', () => {
    // Invented: the container moves on through a second port, and another goes back unused.
    const reply = structuredClone(twoContainers);
    const [first, second] = reply.payload;
    first!.events[3] = { ...first!.events[3]!, eventCode: 'GIF', eventName: 'GATE IN FULL', eventSaat: '12:00:00', ekVeri3: '2' };
    second!.events = [second!.events[0]!, { ...second!.events[0]!, eventCode: 'GIE', eventName: 'GATE IN EMPTY', eventTarih: '03.03.2026', ekVeri3: '2' }];
    const result = parseTurkon(body(reply), SYNTHETIC);
    expect(result.events![0]).toMatchObject({ provider_code: 'GIF', stage: 'in_transit' });
    expect(result.events!.find((event) => event.provider_code === 'GIE')).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'GATE IN FULL' });
  });

  it('keeps a move it cannot stage', () => {
    // Invented: a code the map does not know.
    const reply = structuredClone(sample);
    reply.payload[0]!.events.push({ ...reply.payload[0]!.events[5]!, eventCode: 'XYZ', eventName: 'SOMETHING NEW', eventTarih: '07.05.2025' });
    const result = parseTurkon(body(reply), BOOKING);
    expect(result.events![0]).toEqual({ local_time: '2025-05-07T14:05:00', description: 'SOMETHING NEW', location: 'NEWYORK APM TERMINAL ELIZABETH', provider_code: 'XYZ' });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'SOMETHING NEW' });
  });

  it('answers only for the number asked', () => {
    expect(() => parseTurkon(body(unknown), BOOKING)).toThrow(NotFoundError);
    expect(() => parseTurkon(body(sample), { kind: 'booking', number: '10186119' })).toThrow(IndeterminateError);
    expect(parseTurkon(body(sample), { kind: 'container', number: 'TRKU4450480' })).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseTurkon(body(sample), { kind: 'container', number: 'TRKU4450491' })).toThrow(IndeterminateError);
    const mixed = structuredClone(twoContainers); mixed.payload[1]!.bookingNo = '00000000000099999902';
    expect(() => parseTurkon(body(mixed), SYNTHETIC)).toThrow(IndeterminateError);
    const container = structuredClone(twoContainers);
    expect(parseTurkon(body(container), { kind: 'container', number: 'ZZZU0000012' }).events!.map((event) => event.local_time))
      .toEqual(['2026-03-04T10:00:00', '2026-03-02T11:00:00', '2026-03-01T08:30:00']);
  });

  it('refuses a reply it cannot read', () => {
    const edit = (change: (reply: typeof sample) => void) => { const reply = structuredClone(sample); change(reply); return body(reply); };
    expect(() => parseTurkon('<html>', BOOKING)).toThrow(SchemaError);
    expect(() => parseTurkon('null', BOOKING)).toThrow(SchemaError);
    expect(() => parseTurkon(body({ hasError: false, payload: 'unreadable' }), BOOKING)).toThrow(SchemaError);
    expect(() => parseTurkon(body({ hasError: true, errorMessages: 1, payload: [] }), BOOKING)).toThrow(TransportError);
    expect(() => parseTurkon(edit((reply) => { reply.payload[0]!.bookingNo = ''; }), BOOKING)).toThrow(SchemaError);
    expect(() => parseTurkon(edit((reply) => { (reply.payload[0] as Record<string, unknown>).events = 'unreadable'; }), BOOKING)).toThrow(SchemaError);
    for (const change of [{ eventTarih: '2025-04-08' }, { eventTarih: '31.02.2025' }, { eventSaat: '25:00:00' }, { eventCode: '' },
      { eventName: ' ' }, { containerNo: 'TRKU0000000' }]) {
      expect(() => parseTurkon(edit((reply) => { Object.assign(reply.payload[0]!.events[2]!, change); }), BOOKING), JSON.stringify(change)).toThrow(SchemaError);
    }
    expect(() => parseTurkon(edit((reply) => { reply.payload[0]!.events = []; }), BOOKING)).toThrow(NoHistoryError);
  });

  it('takes a container, a booking or a TRKU bill, and refuses anything else before asking', async () => {
    expect(turkonQuery(BILL)).toEqual(BOOKING);
    expect(turkonQuery(' trku 1018 6118 ')).toEqual(BOOKING);
    expect(turkonQuery('TRKU4450480')).toEqual({ kind: 'container', number: 'TRKU4450480' });
    expect(containerCheckDigit('CSQU305438')).toBe(3);
    const h = harness();
    for (const number of ['TRKU4450481', 'TRKU', '12345', 'ABCDE12345678', 'TRKU10186118X', '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).carrier, record.number).not.toBe('turkon-line');
  });

  it('asks the browser service to search the booking and capture its containers’ lookup', async () => {
    const h = harness();
    await expect(h.tracker.fetch(BILL)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: 'https://myturkonline.turkon.com/tracking?tracking=10186118', skipHttp: true, maxTier: 3,
      captureResponses: ['https://myturkonline.turkon.com/shipping-prod-service/tracking/getTrackingLowerInformation/en/10186118'] });
    expect(adapter(h.environment)).toMatchObject({ id: 'turkon-line', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(BILL, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(BILL, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads an unknown number as not found, a check as a challenge, and other answers as what they are', async () => {
    const page = turkonPageUrl(BOOKING.number);
    await expect(harness([capture(unknown)]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture(null, { body: '', error: 'challenge-html' })]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 403, body: '' })]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'turkon-line-capture_missing', page, 403).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 429, body: '', headers: { 'retry-after': '60' } })]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture(null, { status: 502, body: '' })]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'indeterminate', status: 502 });
    await expect(harness([capture(sample, { trackingNumberSubmitted: '10186119' })]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(), capture(), capture()]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(sample, { truncated: true })]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { body: '<html>', error: 'invalid-json' })]).tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture()], 'turkon-line-reply', 'https://myturkonline.turkon.com/').tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 'turkon-line-capture_missing').tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'turkon-line-runtime').tracker.fetch(BILL)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new TurkonTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(BILL))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps every move it has seen', () => {
    for (const entry of statuses.entries) {
      expect(turkonStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'turkon-line', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter, containerCheckDigit, HapagTracker, hapagEventsUrl, hapagPageUrl, hapagQuery, parseHapag } from './adapter.js';
import { hapagStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import sample from './fixtures/synthetic-container.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };
import twoContainers from './fixtures/synthetic-bill-two-containers.json' with { type: 'json' };

const CONTAINER = { kind: 'container', reference: 'ZZZU0000023' } as const;
const SYNTHETIC = { kind: 'bill', reference: 'HLCUZZZ999999999' } as const;
const NUMBER = SYNTHETIC.reference;
const body = (data: unknown) => JSON.stringify(data);
const capture = (data: unknown = twoContainers, extra: Record<string, unknown> = {}) => ({ url: hapagEventsUrl(NUMBER), status: 200,
  trackingNumberSubmitted: NUMBER, headers: {}, body: body(data), ...extra });
function harness(rows: unknown[] = [capture()], reason = 'hapag-lloyd-reply', url = hapagPageUrl(NUMBER), statusCode = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ url, html: '', statusCode,
    tier: 3, cookies: [], capturedResponses: rows, timings: [{ tier: 3, reason }] }), { headers: { 'content-type': 'application/json' } }));
  const environment = { fetcher, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null, trawl: new TrawlClient('https://trawl.invalid') };
  return { fetcher, environment, tracker: new HapagTracker(environment) };
}

describe('Hapag-Lloyd tracker', () => {
  it('reads a container from Bremerhaven through Algeciras to Santos, returned empty', () => {
    const result = parseHapag(body(sample), CONTAINER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Gated in', last_update: null, last_update_local: '2026-02-11T14:20:00', expected_delivery: null });
    expect(result).not.toHaveProperty('planned_events');
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-02-11T14:20:00', 'Gated in', 'delivered'],
      ['2026-02-06T10:50:00', 'Gated out', 'out_for_delivery'],
      ['2026-02-02T21:05:00', 'Discharged', 'in_transit'],
      ['2026-02-02T09:30:00', 'Vessel arrived', 'in_transit'],
      ['2026-01-19T16:00:00', 'Vessel departed', 'in_transit'],
      ['2026-01-19T07:20:00', 'Loaded', 'in_transit'],
      ['2026-01-15T19:45:00', 'Discharged', 'in_transit'],
      ['2026-01-15T11:00:00', 'Vessel arrived', 'in_transit'],
      ['2026-01-10T04:30:00', 'Vessel departed', 'in_transit'],
      ['2026-01-09T22:15:00', 'Loaded', 'in_transit'],
      ['2026-01-07T13:40:00', 'Gated in', 'accepted'],
      ['2026-01-05T08:10:00', 'Gated out', 'registered'],
    ]);
    expect(result.events![11]).toEqual({ local_time: '2026-01-05T08:10:00', description: 'Gated out', location: 'BREMERHAVEN',
      stage: 'registered', stage_source: 'carrier_map' });
  });

  it('keeps the containers’ shared vessel moves once, the moves still due apart, and waits for every container', () => {
    const result = parseHapag(body(twoContainers), SYNTHETIC);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Gated out',
      last_update_local: '2026-03-25T10:00:00' });
    expect(result.events).toHaveLength(16);
    expect(result.events!.filter((event) => event.description === 'Vessel departed')).toHaveLength(1);
    expect(result.events!.slice(0, 6).map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-03-25T10:00:00', 'Gated out', 'CHICAGO, IL', 'out_for_delivery'],
      ['2026-03-24T15:00:00', 'Gated in', 'NEW YORK, NY', 'delivered'],
      ['2026-03-22T09:00:00', 'Gated in', 'CHICAGO, IL', 'in_transit'],
      ['2026-03-22T07:00:00', 'Arrival in', 'CHICAGO, IL', 'in_transit'],
      ['2026-03-20T09:00:00', 'Gated out', 'NEW YORK, NY', 'out_for_delivery'],
      ['2026-03-19T12:00:00', 'Gated out', 'NEW YORK, NY', 'in_transit'],
    ]);
    expect(normalizeCarrierResult(result).planned_events).toEqual([
      { local_time: '2026-03-27T00:00:00', description: 'Gated in', location: 'CHICAGO, IL', stage: 'delivered' },
    ]);
    const done = structuredClone(twoContainers);
    const second = done.groups[1]!.events;
    second[second.length - 1] = { ...second.at(-1)!, eventClassifierCode: 'Actual' };
    expect(parseHapag(body(done), SYNTHETIC)).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
    expect(parseHapag(body(twoContainers), { kind: 'container', reference: 'ZZZU0000001' })).toMatchObject({ current_stage: 'delivered' });
  });

  it('stages a gate move by its place among the moves', () => {
    // Invented: a container gated in at an inland terminal and railed to the port before loading, not yet at sea.
    const reply = structuredClone(sample);
    const [out, gateIn] = reply.groups[0]!.events;
    reply.groups[0]!.events = [out!, gateIn!, { ...gateIn!, eventDescription: 'Gated out', eventDate: '2026-01-08', eventTransport: 'Rail' },
      { ...gateIn!, eventDate: '2026-01-09', eventTransport: 'Rail' }];
    expect(parseHapag(body(reply), CONTAINER).events!.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'accepted', 'registered']);
    // Invented: only the empty container released so far.
    reply.groups[0]!.events = [out!];
    expect(parseHapag(body(reply), CONTAINER)).toMatchObject({ status: 'pending', current_stage: 'registered' });
  });

  it('keeps a move it cannot stage', () => {
    // Invented: an inspection after the discharge.
    const reply = structuredClone(sample);
    reply.groups[0]!.events.splice(10, 0, { ...reply.groups[0]!.events[9]!, eventDescription: 'Inspected', eventTime: '20:00' });
    const result = parseHapag(body(reply), CONTAINER);
    expect(result.events!.find((event) => event.description === 'Inspected')).toEqual({ local_time: '2026-02-02T20:00:00',
      description: 'Inspected', location: 'SANTOS' });
    expect(result).toMatchObject({ current_stage: 'delivered' });
  });

  it('answers only for the container asked', () => {
    expect(() => parseHapag(body({ groups: [] }), CONTAINER)).toThrow(NotFoundError);
    expect(() => parseHapag(body(sample), { kind: 'container', reference: 'ZZZU0000034' })).toThrow(IndeterminateError);
    expect(parseHapag(body(sample), { kind: 'booking', reference: '12345678' })).toMatchObject({ current_stage: 'delivered' });
  });

  it('refuses a reply it cannot read', () => {
    const edit = (change: (reply: typeof sample) => void) => { const reply = structuredClone(sample); change(reply); return body(reply); };
    expect(() => parseHapag('<html>', CONTAINER)).toThrow(SchemaError);
    expect(() => parseHapag('null', CONTAINER)).toThrow(SchemaError);
    expect(() => parseHapag(body({ groups: 'unreadable' }), CONTAINER)).toThrow(SchemaError);
    expect(() => parseHapag(edit((reply) => { reply.groups[0]!.containerNumber = ''; }), CONTAINER)).toThrow(SchemaError);
    expect(() => parseHapag(edit((reply) => { (reply.groups[0] as Record<string, unknown>).events = 'unreadable'; }), CONTAINER)).toThrow(SchemaError);
    for (const change of [{ eventDate: '04.08.2026' }, { eventDate: '2026-02-30' }, { eventTime: '25:00' }, { eventTime: '15:16+02:00' },
      { eventDescription: ' ' }, { eventClassifierCode: 'Unknown' }, { containerNumber: 'ZZZU0000012' }]) {
      expect(() => parseHapag(edit((reply) => { Object.assign(reply.groups[0]!.events[2]!, change); }), CONTAINER), JSON.stringify(change)).toThrow(SchemaError);
    }
    expect(() => parseHapag(edit((reply) => { reply.groups[0]!.events = []; }), CONTAINER)).toThrow(NoHistoryError);
    expect(() => parseHapag(edit((reply) => {
      for (const event of reply.groups[0]!.events) event.eventClassifierCode = 'Planned';
    }), CONTAINER)).toThrow(NoHistoryError);
  });

  it('takes a container with its check digit, a booking or a bill of lading, and refuses anything else before asking', async () => {
    expect(hapagQuery(` ${numbers.records[0]!.number.slice(0, 4).toLowerCase()} ${numbers.records[0]!.number.slice(4, 10)}-${numbers.records[0]!.number[10]} `))
      .toEqual({ kind: 'container', reference: numbers.records[0]!.number });
    expect(hapagQuery('12345678')).toEqual({ kind: 'booking', reference: '12345678' });
    expect(hapagQuery('hlcuzzz999999999')).toEqual(SYNTHETIC);
    expect(containerCheckDigit('CSQU305438')).toBe(3);
    const h = harness();
    for (const number of ['ZZZU0000023', 'ZZZU', '123456789', 'HLCUZZZ99999999', 'HLCUZZZ9999999999', '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).carrier, record.number).not.toBe('hapag-lloyd');
  });

  it('asks the browser service to open the page for the reference and capture its lookup', async () => {
    const h = harness();
    await expect(h.tracker.fetch(' hlcuzzz 999999999 ')).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      url: 'https://www.hapag-lloyd.com/solutions/tracking/#/HLCUZZZ999999999', skipHttp: true, maxTier: 3,
      captureResponses: ['https://tracking.api.hlag.cloud/api/tracking/v3/events?reference=HLCUZZZ999999999'] });
    expect(adapter(h.environment)).toMatchObject({ id: 'hapag-lloyd', steps: ['trawl'] });
    expect(adapter(h.environment).recognize).toBeUndefined();
    const stopped = new AbortController(); stopped.abort();
    await expect(h.tracker.fetch(NUMBER, { signal: stopped.signal })).rejects.toThrow();
    await expect(h.tracker.fetch(NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'budget' });
  });

  it('reads an unknown reference as not found, a check as a challenge, and other answers as what they are', async () => {
    const page = hapagPageUrl(NUMBER);
    await expect(harness([capture(unknown, { status: 422 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture({ errorKey: 'bcm.container-not-found' }, { status: 422 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness([capture({ errorKey: 'dcsa.ambiguous-shipment-data' }, { status: 422 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(harness([capture({ errorKey: 'dcsa.something-else' }, { status: 422 })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 422 });
    await expect(harness([capture(null, { status: 404, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 404 });
    await expect(harness([capture(null, { body: '', error: 'challenge-html' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 401, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([], 'hapag-lloyd-capture_missing', page, 403).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness([capture(null, { status: 429, body: '', headers: { 'retry-after': '60' } })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 60000 });
    await expect(harness([capture(null, { status: 502, body: '' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', status: 502 });
    await expect(harness([capture(twoContainers, { trackingNumberSubmitted: 'HLCUZZZ999999998' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(), capture(), capture()]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(twoContainers, { truncated: true })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture(null, { body: null, error: 'invalid-json' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([capture(null, { body: null, error: 'body-read' })]).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([capture()], 'hapag-lloyd-reply', 'https://www.hapag-lloyd.com/').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness([], 'hapag-lloyd-capture_missing').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness([], 'hapag-lloyd-runtime').tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  });

  it('needs the browser service', async () => {
    await expect(new HapagTracker({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null }).fetch(NUMBER))
      .rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps every wording it knows, and leaves the gate moves to their place', () => {
    for (const entry of statuses.entries) {
      expect(hapagStage(entry.wording), entry.wording).toBe((entry as { stage?: string }).stage);
      const answer = statusMapAnswer({ carrier: 'hapag-lloyd', providerCode: null, description: entry.wording });
      expect(answer.kind, entry.wording).toBe((entry as { stage?: string }).stage ? 'mapped' : 'intentional_gap');
    }
    expect(normalizeStatusWording('Gated in')).toBe('gated in');
  });
});

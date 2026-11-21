import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CARGOLUX_API, cargoluxLookupUrl } from './adapter.js';
import { normalizeCargoluxWaybill, parseCargolux } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = '172-87779521';
const UNKNOWN = '172-12345675';

type Event = Record<string, unknown>;
type Airport = { airportCode: string; cityName: string; countryIso: string; events: Event[] };
type Tracking = { awbNumber: string; shipmentSummary: Record<string, unknown> | null; airportEvents: Airport[] | null };
type Reply = { trackings: Tracking[]; invalidAwbNumbers: string[] };

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The public sample's reply, with its summary and airports changed by `change`. */
const sample = (change: (tracking: Tracking) => void = () => {}): Reply => {
  const reply = fixture(`awb-${SAMPLE}`);
  change(reply.trackings[0]!);
  return reply;
};
const airport = (tracking: Tracking, code: string) => tracking.airportEvents!.find((value) => value.airportCode === code)!;
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Cargolux numbers', () => {
  it('takes a waybill with its prefix 172 or 356, or the serial alone as Cargolux’s', () => {
    expect(normalizeCargoluxWaybill(' 172-8777 9521 ')).toBe(SAMPLE);
    expect(normalizeCargoluxWaybill('17287779521')).toBe(SAMPLE);
    expect(normalizeCargoluxWaybill('87779521')).toBe(SAMPLE);
    expect(normalizeCargoluxWaybill('356 12345675')).toBe('356-12345675');
    for (const other of ['', '125-12345675', '172-87779520', '1728777952', '172877795211', 'CV-87779521', '172/87779521']) {
      expect(() => normalizeCargoluxWaybill(other), other).toThrow('Enter a Cargolux air waybill');
    }
  });
});

describe('Cargolux tracking adapter', () => {
  it('asks the tracker’s service for the whole waybill, as the page’s script does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(`awb-${SAMPLE}`)));
    await expect(carrier(fetcher).track({ number: '87779521' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CARGOLUX_API}/api/track/awbs/?numbers=172-87779521`);
    expect(cargoluxLookupUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json, text/plain, */*' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'cargolux', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads an empty record as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, verification pages and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response, number = UNKNOWN) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Service Unavailable</title>', 503))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<title>Just a moment...</title>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><body>Cargolux</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.cargolux.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ trackings: [], invalidAwbNumbers: [UNKNOWN] }))).toMatchObject({ kind: 'invalid_input' });
    expect(await answer(() => json(fixture(`awb-${SAMPLE}`)))).toMatchObject({ kind: 'indeterminate' });
  });
});

describe('Cargolux replies', () => {
  it('reads the public sample: its scans on the stations’ clocks, its flights, parts and destination', () => {
    const result = parseCargolux(fixture(`awb-${SAMPLE}`), SAMPLE);
    const jnb = 'Johannesburg (JNB)', lux = 'Luxembourg (LUX)';
    const at = (code: string, stage: string) => ({ provider_code: code, stage, stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-06-30T13:34:00+02:00', expected_delivery: null, destination_country: 'ZA',
      events: [
        { time: '2026-06-30T13:34:00+02:00', description: 'Delivered', location: jnb, ...at('DLV', 'delivered') },
        { time: '2026-06-29T17:37:00+02:00', description: 'Received from flight on CV2601 (12 of 37 pieces)', location: jnb, ...at('RCF', 'in_transit') },
        { time: '2026-06-29T17:33:00+02:00', description: 'Documents delivered', location: jnb, ...at('AWD', 'ready_for_pickup') },
        { time: '2026-06-29T17:33:00+02:00', description: 'Ready for pickup (25 of 37 pieces)', location: jnb, ...at('NFD', 'ready_for_pickup') },
        { time: '2026-06-29T16:57:00+02:00', description: 'Arrived on CV2601', location: jnb, ...at('ARR', 'in_transit') },
        { time: '2026-06-29T06:31:00+02:00', description: 'Departed on CV2601', location: lux, ...at('DEP', 'in_transit') },
        { time: '2026-06-29T02:32:52+02:00', description: 'Ready for carriage', location: lux, ...at('RCS', 'accepted') },
        { time: '2026-06-29T02:32:45+02:00', description: 'on hand', location: lux, ...at('FOH', 'accepted') },
        { time: '2026-06-29T02:27:39+02:00', description: 'FWB Data Capture', location: lux, ...at('CPT', 'registered') },
        // The tracker dates the first part's reception before the flight left; its clock is kept as given.
        { time: '2026-06-28T07:32:00+02:00', description: 'Received from flight on CV2601 (25 of 37 pieces)', location: jnb, ...at('RCF', 'in_transit') },
      ],
    });
    // The agent, the goods, handling codes, weights and volumes stay behind.
    expect(JSON.stringify(result)).not.toMatch(/DSV|CONSOLIDATION|DGR|3777|31\.951/);
  });

  it('keeps the steps the tracker has not processed as planned, not as scans', () => {
    const reply = sample((tracking) => {
      const jnb = airport(tracking, 'JNB');
      jnb.events = [{ ...jnb.events[0]!, isProcessed: false }];
    });
    expect(parseCargolux(reply, SAMPLE)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Departed on CV2601', destination_country: 'ZA',
      planned_events: [{ time: '2026-06-29T16:57:00+02:00', description: 'Planned to arrive on CV2601', location: 'Johannesburg (JNB)', stage: 'in_transit' }],
    });
    const booked = sample((tracking) => {
      for (const value of tracking.airportEvents!) value.events = value.events.map((event) => ({ ...event, isProcessed: false }));
    });
    expect(() => parseCargolux(booked, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed',
      plannedEvents: expect.arrayContaining([expect.objectContaining({ description: 'Planned for delivery' })]) }));
  });

  it('delivers a waybill handed over in parts once all its pieces are delivered', () => {
    const delivery = (tracking: Tracking) => airport(tracking, 'JNB').events.find((event) => event.eventType === 'DLV')!;
    const part = sample((tracking) => { delivery(tracking).pieces = 25; });
    expect(parseCargolux(part, SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Delivered (25 of 37 pieces)' });
    const both = sample((tracking) => {
      const first = delivery(tracking);
      first.pieces = 25;
      airport(tracking, 'JNB').events.push({ ...first, pieces: 12, time: '2026-07-01T09:00:00+02:00' });
    });
    expect(parseCargolux(both, SAMPLE)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered (12 of 37 pieces)' });
  });

  it('files a pickup notice or a delivery away from the waybill’s destination as a step on the way', () => {
    const elsewhere = sample((tracking) => { tracking.shipmentSummary!.destination = 'CPT'; });
    const result = parseCargolux(elsewhere, SAMPLE);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(result.destination_country).toBeUndefined();
    expect(result.events!.filter((event) => event.location === 'Johannesburg (JNB)').every((event) => event.stage === 'in_transit')).toBe(true);
  });

  it('names a road feeder service as a truck', () => {
    const truck = sample((tracking) => {
      const lux = airport(tracking, 'LUX');
      lux.events = lux.events.map((event) => event.eventType === 'DEP' ? { ...event, flightNumber: 'CV9701Z' } : event);
    });
    expect(parseCargolux(truck, SAMPLE).events!.find((event) => event.provider_code === 'DEP')).toMatchObject({ description: 'Departed by truck CV9701Z' });
  });

  it('refuses an answer about another waybill', () => {
    expect(() => parseCargolux(sample((tracking) => { tracking.shipmentSummary!.awb = '172-12345675'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCargolux(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const event = (change: Event) => sample((tracking) => { airport(tracking, 'LUX').events[0] = { ...airport(tracking, 'LUX').events[0]!, ...change }; });
    for (const reply of [null, {}, { trackings: {}, invalidAwbNumbers: [] }, { trackings: [], invalidAwbNumbers: [] },
      sample((tracking) => { tracking.shipmentSummary = null; }), sample((tracking) => { tracking.shipmentSummary!.destination = 'Johannesburg'; }),
      sample((tracking) => { tracking.shipmentSummary!.statedPieces = '37'; }), sample((tracking) => { tracking.airportEvents![0]!.airportCode = 'Lux'; }),
      event({ time: '2026-06-29T02:27:39' }), event({ eventType: 'Departed' }), event({ isProcessed: 'yes' }), event({ pieces: -1 })]) {
      expect(() => parseCargolux(reply, SAMPLE), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Cargolux statuses', () => {
  it('maps each code of the tracker’s translations, and leaves the ones that keep the stage before them as gaps', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording) ?? null, entry.code).toBe(entry.stage);
      const answer = statusMapAnswer({ carrier: 'cargolux', providerCode: entry.code, description: entry.wording });
      expect(answer, entry.code).toMatchObject(entry.stage ? { kind: 'mapped', stage: entry.stage } : { kind: 'intentional_gap' });
    }
    expect(statusMap.stage('XYZ', 'anything')).toBeUndefined();
  });
});

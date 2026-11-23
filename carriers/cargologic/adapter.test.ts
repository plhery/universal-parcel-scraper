import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CARGOLOGIC_API, cargologicLookupUrl } from './adapter.js';
import { normalizeCargologicWaybill, parseCargologic } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const EXPORT = '016-91176875';
const UNKNOWN = '724-12345675';

type Step = Record<string, unknown>;
type Reply = { type: string; originStation: string; destination: string; row: Record<string, Step[]> } & Record<string, unknown>;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** A fixture with its steps changed by `change`. */
const changed = (name: string, change: (reply: Reply) => void): Reply => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answer = async (response: () => Response, number = UNKNOWN) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
  .track({ number }, { budgetMs: 2000 }).catch((error: unknown) => error);
const zurich = 'Zurich (ZRH)';
const at = (code: string, stage: string) => ({ provider_code: code, stage, stage_source: 'carrier_map' });

describe('Cargologic numbers', () => {
  it('takes any airline’s waybill whose check digit holds, written as the page’s search box writes it', () => {
    for (const written of [EXPORT, '01691176875', ' 016 9117 6875 ', '016-9117 6875']) {
      expect(normalizeCargologicWaybill(written), written).toBe('016-9117 6875');
    }
    expect(normalizeCargologicWaybill('72412345675')).toBe('724-1234 5675');
    for (const other of ['', '016-91176870', '1691176875', '016911768750', 'UA-91176875', '016/91176875']) {
      expect(() => normalizeCargologicWaybill(other), other).toThrow('Enter an air waybill');
    }
  });

  it('leaves Lufthansa Cargo’s waybills to Lufthansa Cargo, as the page does', () => {
    expect(() => normalizeCargologicWaybill('020-12345675')).toThrow(expect.objectContaining({ kind: 'invalid_input', message: expect.stringContaining('Lufthansa') }));
  });
});

describe('Cargologic tracking adapter', () => {
  it('asks the tracking service for the waybill as the page’s component does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('export')));
    await expect(carrier(fetcher).track({ number: '01691176875' })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CARGOLOGIC_API}?awb=016-9117+6875`);
    expect(cargologicLookupUrl('016-9117 6875')).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json, text/plain, */*' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'cargologic', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the 404 that names the waybill as not found, and one naming another waybill as inconclusive', async () => {
    expect(await answer(() => json(fixture('not-found'), { status: 404 }))).toMatchObject({ kind: 'not_found' });
    expect(await answer(() => json({ error: `No Tracing Information available for ${UNKNOWN}.` }, { status: 404 }))).toMatchObject({ kind: 'not_found' });
    expect(await answer(() => json(fixture('not-found'), { status: 404 }), EXPORT)).toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps a transit shipment, refusals, verification pages and redirects apart from a missing shipment', async () => {
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({ error: 'Type TRANSIT not allowed' }, { status: 451 }))).toMatchObject({ kind: 'indeterminate', reason: 'tracking_withheld' });
    expect(await answer(() => json({ error: 'AWB Number format not correct.' }, { status: 400 }))).toMatchObject({ kind: 'invalid_input' });
    expect(await answer(() => json({ error: 'Something else' }, { status: 404 }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({}, { status: 404 }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({}, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Service Unavailable</title>', 503))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<title>Just a moment...</title>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Not Found</title>', 404))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.cargologic.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Cargologic replies', () => {
  it('reads an export: received, ready and flown out of Zurich', () => {
    expect(parseCargologic(fixture('export'))).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Departed on UA135', last_update: '2026-05-10T10:10:00+02:00', expected_delivery: null,
      events: [
        { time: '2026-05-10T10:10:00+02:00', description: 'Departed on UA135', location: zurich, ...at('DEP', 'in_transit') },
        // Steps dated alike keep the page's order.
        { time: '2026-05-08T12:11:00+02:00', description: 'Ready for export', location: zurich, ...at('RCS', 'accepted') },
        { time: '2026-05-08T12:11:00+02:00', description: 'Received by Cargologic', location: zurich, ...at('FOH', 'accepted') },
      ],
    });
  });

  it('reads an import: manifested, received from the flight, announced and handed to the forwarder', () => {
    const result = parseCargologic(fixture('import'));
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered to the forwarder', last_update: '2025-06-27T08:55:00+02:00', expected_delivery: null,
      events: [
        { time: '2025-06-27T08:55:00+02:00', description: 'Delivered to the forwarder', location: zurich, ...at('DLV', 'delivered') },
        { time: '2025-06-26T14:46:00+02:00', description: 'Forwarder notified of arrival', location: zurich, ...at('NFD', 'ready_for_pickup') },
        { time: '2025-06-26T14:46:00+02:00', description: 'Received from the flight', location: zurich, ...at('RCF', 'in_transit') },
        // A manifest announces goods still on the flight.
        { time: '2025-06-25T23:08:00+02:00', description: 'Manifested on UA134', ...at('FFM', 'in_transit') },
      ],
    });
    // Pieces and weight stay behind.
    expect(JSON.stringify(result)).not.toMatch(/170|EWR/);
  });

  it('dates winter steps on Zurich’s winter clock and counts a step that saw part of the pieces', () => {
    const winter = changed('export', (reply) => {
      reply.row.position4List = [{ ...reply.row.position4List![0]!, date: '05DEC25', time: '07:05', pieces: '3 / 5', flightInfo: 'UA 135/05DEC25' }];
    });
    expect(parseCargologic(winter).events!.find((event) => event.provider_code === 'DEP')).toEqual({ time: '2025-12-05T07:05:00+01:00', description: 'Departed on UA135 (3 of 5 pieces)', location: zurich, ...at('DEP', 'in_transit') });
    const noFlight = changed('export', (reply) => { delete reply.row.position4List![0]!.flightInfo; });
    expect(parseCargologic(noFlight).last_status_text).toBe('Departed');
  });

  it('reads a waybill without a step yet as listed, not as a shipment with history', () => {
    const booked = changed('export', (reply) => {
      for (const [key, list] of Object.entries(reply.row)) reply.row[key] = list.map((step) => ({ active: false, code: step.code }));
    });
    expect(() => parseCargologic(booked)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a changed reply', () => {
    const step = (change: Step) => changed('export', (reply) => { reply.row.position2List = [{ ...reply.row.position2List![0]!, ...change }]; });
    for (const reply of [null, {}, { ...fixture('export'), row: [] }, { ...fixture('export'), type: 'COURIER' },
      { ...fixture('export'), destination: 'Los Angeles' }, changed('export', (reply) => { reply.row.positionList = []; }),
      changed('export', (reply) => { reply.row.position5List = {} as unknown as Step[]; }),
      step({ active: 'yes' }), step({ code: 'Received' }), step({ date: '2026-05-08' }), step({ time: '' }), step({ date: 8 })]) {
      expect(() => parseCargologic(reply), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Cargologic statuses', () => {
  it('maps each Cargo-IMP code the page’s legend explains', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'cargologic', providerCode: entry.code, description: entry.wording }), entry.code)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('XYZ', 'anything')).toBeUndefined();
  });
});

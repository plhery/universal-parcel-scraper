import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SHIPAGENT_API, shipAgentLookupUrl } from './adapter.js';
import { normalizeShipAgentNumber, parseShipAgent } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' replies; the tests derive invented shipments from them.
const ABROAD = 'SA260899579915', ABROAD_AWB = 'SG32608036587148', DOMESTIC = '59120810000103';
const OTHER = 'SA260899579916';

type Row = Record<string, unknown>;
type Reply = { success: boolean; data: { shipment: Record<string, unknown>; timeline: Row[]; updatedAt: string } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** A sample's reply with its shipment fields and its rows changed. */
const edit = (name: string, shipment: Record<string, unknown> = {}, rows?: (timeline: Row[]) => Row[]): Reply => {
  const reply = fixture(name);
  return { ...reply, data: { ...reply.data, shipment: { ...reply.data.shipment, ...shipment }, timeline: rows ? rows(reply.data.timeline) : reply.data.timeline } };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ShipAgent numbers', () => {
  it('takes its own reference or a courier’s AWB in letters and digits', () => {
    expect(normalizeShipAgentNumber(` ${ABROAD.toLowerCase()} `)).toBe(ABROAD);
    expect(normalizeShipAgentNumber(DOMESTIC)).toBe(DOMESTIC);
    for (const other of ['', 'SA01', 'ABCDEFGH', 'SA2608-99579915!', 'SA' + '1'.repeat(40)]) {
      expect(() => normalizeShipAgentNumber(other), other).toThrow('AWB or ShipAgent tracking number');
    }
  });
});

describe('ShipAgent tracking adapter', () => {
  it('asks the public tracking API as the tracking page does, in capitals', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture(ABROAD)));
    await expect(carrier(fetcher).track({ number: ABROAD.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SHIPAGENT_API}${ABROAD}?source=shipagent.in`);
    expect(shipAgentLookupUrl(ABROAD)).toBe(`https://api.shipagent.in/api/v1/public/tracking/${ABROAD}?source=shipagent.in`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Accept: 'application/json' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'shipagent-in', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the API’s not-found reply as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found'), { status: 404 }));
    await expect(carrier(fetcher).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, challenges, error pages and redirects apart from a missing shipment', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({ success: false, error: { type: 'RATE_LIMITED' } }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({ success: false, error: { type: 'FORBIDDEN' } }, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>Not Found</h1>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json({ success: false, error: { type: 'BAD_REQUEST' } }, { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.shipagent.in/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
  });
});

describe('ShipAgent replies', () => {
  it('reads the international sample: its rows on their wall clock, where it went and ShipGlobal’s AWB', () => {
    const result = parseShipAgent(fixture(ABROAD), ABROAD);
    const events = result.events ?? [];
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'delivered',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-08-13T09:52:55', expected_delivery: null,
      service_name: 'ShipAgent Rakhi Special', destination_country: 'US', delivery_carrier: 'shipglobal-in', delivery_tracking_number: ABROAD_AWB,
    });
    expect(result.summary_only).toBeUndefined();
    expect(result.unread_estimates).toBeUndefined();
    expect(events).toHaveLength(16);
    expect(events[0]).toEqual({ local_time: '2026-08-13T09:52:55', description: 'Shipment Delivered', provider_code: 'delivered',
      location: 'Garden Grove, CA', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events.find((event) => event.description === 'Your shipment is being inspected by customs'))
      .toEqual({ local_time: '2026-08-12T03:33:00', description: 'Your shipment is being inspected by customs', provider_code: 'in_transit',
        location: 'USA', stage: 'customs', stage_source: 'carrier_map' });
    expect(events.find((event) => event.description?.startsWith('We need additional information'))).toMatchObject({ stage: 'exception' });
    // A row the service codes unknown keeps no code, and its "-" is no place.
    expect(events.at(-1)).toEqual({ local_time: '2026-08-03T19:03:16', description: 'Shipment Created, Awaiting Package',
      stage: 'registered', stage_source: 'carrier_map' });
    // The order's reference and the towns it goes from and to stay behind.
    expect(JSON.stringify(result)).not.toMatch(/ORDER-REFERENCE|kurukshetra|Haryana/i);
  });

  it('answers ShipGlobal’s AWB itself, naming ShipGlobal without a second number', () => {
    const result = parseShipAgent(fixture(ABROAD), ABROAD_AWB);
    expect(result).toMatchObject({ current_stage: 'delivered', delivery_carrier: 'shipglobal-in' });
    expect(result.delivery_tracking_number).toBeUndefined();
    // An AWB that is not ShipGlobal's shape names no partner.
    expect(parseShipAgent(edit(ABROAD, { awbNumber: 'SG1234' }), ABROAD).delivery_carrier).toBeUndefined();
  });

  it('reads a courier’s bare status within India as a summary and hands the AWB to that courier', () => {
    const result = parseShipAgent(fixture(DOMESTIC), DOMESTIC);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'delivered',
      last_status_text: 'Delivered', last_update: null, expected_delivery: null, destination_country: 'IN',
      delivery_carrier: 'delhivery', summary_only: true, events: [],
    });
    // A courier the catalog does not know names no partner.
    expect(parseShipAgent(edit(DOMESTIC, { courierName: 'Some Local Courier' }), DOMESTIC).delivery_carrier).toBeUndefined();
  });

  it('keeps a courier’s row that is not stamped with the read', () => {
    const scanned = edit(DOMESTIC, { lastScan: '2026-08-02T13:18:01.002Z' }, (rows) => rows.map((row) => ({ ...row, timestamp: '2026-08-02T13:18:01.002Z' })));
    expect(parseShipAgent(scanned, DOMESTIC)).toMatchObject({ last_update_local: '2026-08-02T13:18:01',
      events: [{ local_time: '2026-08-02T13:18:01', description: 'Delivered', provider_code: 'delivered', stage: 'delivered' }] });
    expect(parseShipAgent(scanned, DOMESTIC).summary_only).toBeUndefined();
  });

  it('takes the stage from the newest row when the shipment’s status is unknown, and leaves its estimate unread', () => {
    const open = edit(ABROAD, { status: 'unknown', statusLabel: 'Status unavailable', estimatedDelivery: '2026-08-15T00:00:00.000Z' },
      (rows) => rows.slice(0, -2));
    const result = parseShipAgent(open, ABROAD);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrived at GOFO Regional Hub', last_update_local: '2026-08-12T17:17:27', unread_estimates: ['data.shipment.estimatedDelivery'] });
    expect(result.provider_code).toBeUndefined();
  });

  it('refuses another shipment’s reply', () => {
    expect(() => parseShipAgent(fixture(ABROAD), OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseShipAgent(fixture(DOMESTIC), '59120810000104')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const row = (change: Row) => (rows: Row[]) => [...rows.slice(0, -1), { ...rows.at(-1), ...change }];
    for (const reply of [null, {}, { success: false }, { success: true, data: {} }, edit(ABROAD, {}, () => ({}) as unknown as Row[]),
      edit(ABROAD, {}, row({ timestamp: '2026-08-13 09:52:55' })), edit(ABROAD, {}, row({ timestamp: '2026-02-30T09:52:55.000Z' })),
      edit(ABROAD, {}, row({ status: 'Delivered' })), edit(ABROAD, {}, row({ message: null })), edit(ABROAD, {}, row({ location: 7 })),
      edit(ABROAD, {}, (rows) => [...rows, 'row' as unknown as Row]), edit(ABROAD, { status: 'unknown' }, () => [])]) {
      expect(() => parseShipAgent(reply, ABROAD), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('ShipAgent statuses', () => {
  it('maps each code and wording the service gives', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry && typeof entry.code === 'string' ? entry.code : null;
      expect(statusMap.stage(code, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'shipagent-in', providerCode: code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('in_transit', 'Your shipment is being inspected by customs')).toBe('customs');
    expect(statusMap.stage('xyz', 'anything')).toBeUndefined();
  });
});

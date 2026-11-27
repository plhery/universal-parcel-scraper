import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BLUEGRACE_ACTION, BLUEGRACE_API, BLUEGRACE_PAGE, BluegraceTracker } from './adapter.js';
import { normalizeBluegraceNumber, parseBluegrace, parseBluegraceNonce } from './parser.js';
import { bluegraceStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const LTL = 'BG879578524';
const TRUCKLOAD = 'BG652690023';
const SPLIT = 'BG988712325';
const PRO = '968307804';
const UNKNOWN = 'BG000417203';
const NONCE = '0a1b2c3d4e';

type Row = Record<string, string>;
type Shipment = { bol: string; addresses: Row[]; carrier: Row; references: Row[]; trackingInfo: { pro: string; estimatedDeliveryDate: string | null; details: Row[] } };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(`${name}.json`)) as Shipment[];
const PAGE = text('tracking-page.html');
/** The LTL shipment, changed in place by `change`. */
const ltl = (change: (shipment: Shipment) => void = () => {}): Shipment[] => {
  const reply = fixture('delivered-ltl');
  change(reply[0]!);
  return reply;
};
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...init.headers } });
/** A site that serves the tracking page, then `lookup` for each reference the tracker asks. */
const site = (lookup: (reference: string) => Response, page: () => Response = () => html(PAGE)) => vi.fn<typeof fetch>()
  .mockImplementation(async (url) => (String(url).startsWith(BLUEGRACE_PAGE) ? page()
    : lookup(new URL(String(url)).searchParams.get('refName')!)));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CLOUDFLARE = '<html><head><title>Just a moment...</title></head><script>window._cf_chl_opt={}</script></html>';
const row = (code: string, trackStatus: string, trackingDate: string, city: string, state: string): Row => ({
  trackingDate, trackStatusCode: code, trackStatus, lateReasonCode: 'NS', lateReason: 'NORMAL STATUS', city, state });

describe('BlueGrace Logistics HTTP adapter', () => {
  it('reads the nonce from a fresh tracking page, then asks the lookup for the bill of lading, through the supplied transport', async () => {
    const fetcher = site(() => json(fixture('delivered-ltl')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BluegraceTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bg 879-578-524 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered', delivery_carrier: 'xpo-ltl', delivery_tracking_number: PRO });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[pageUrl, pageInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    // An address no cache holds, so the nonce is current.
    expect(String(pageUrl)).toMatch(/^https:\/\/mybluegrace\.com\/track\/\?_=\d{13}$/);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    const lookup = new URL(String(url));
    expect(`${lookup.origin}${lookup.pathname}`).toBe(BLUEGRACE_API);
    expect(Object.fromEntries(lookup.searchParams)).toEqual({ action: BLUEGRACE_ACTION, nonce: NONCE, refName: 'BOL', refValue: LTL });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bluegrace-logistics', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('asks for a PRO number with the same nonce once no bill of lading matches, and reads an unknown number as not found', async () => {
    const fetcher = site((reference) => json(reference === 'PRO' ? fixture('delivered-ltl') : []));
    await expect(carrier(fetcher).track({ number: PRO })).resolves.toMatchObject({ current_stage: 'delivered', delivery_tracking_number: PRO });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.slice(1).map(([url]) => Object.fromEntries(new URL(String(url)).searchParams))).toEqual([
      { action: BLUEGRACE_ACTION, nonce: NONCE, refName: 'BOL', refValue: PRO },
      { action: BLUEGRACE_ACTION, nonce: NONCE, refName: 'PRO', refValue: PRO },
    ]);

    const unknown = site(() => json(fixture('not-found')));
    await expect(carrier(unknown).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(unknown).toHaveBeenCalledTimes(3);
  });

  it('takes the tracking lookup’s nonce, not the site search’s, and needs exactly one', () => {
    expect(parseBluegraceNonce(PAGE)).toBe(NONCE);
    expect(() => parseBluegraceNonce(PAGE.replace(`"nonce":"${NONCE}"`, '"nonce":""'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBluegraceNonce(PAGE.replace(`"nonce":"${NONCE}"`, '"nonce":"<script>"'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBluegraceNonce(PAGE.replace('var bluegraceTracking', 'var bluegraceOther'))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBluegraceNonce(PAGE.replace('</body>', `<script>var bluegraceTracking = {"nonce":"ffffffffff"};</script></body>`)))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBluegraceNonce(CLOUDFLARE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps each scan once, newest first, dated on the clock of a state with one zone, with the estimates kept out', () => {
    const result = parseBluegrace(fixture('delivered-ltl'), LTL, 'BOL');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'COMPLETED UNLOADING AT DELIVERY LOCATION', last_update: '2024-12-19T11:35:00-08:00', expected_delivery: null,
      delivery_carrier: 'xpo-ltl', delivery_tracking_number: PRO });
    expect(result).not.toHaveProperty('last_update_local');
    const events = result.events!;
    // Neither the estimated delivery rows nor the appointment slot is a scan.
    expect(events).toHaveLength(22);
    expect(events.some((event) => ['AG', 'AB'].includes(event.provider_code!))).toBe(false);
    expect(events.slice(0, 6).map((event) => [event.local_time, event.provider_code, event.description, event.stage])).toEqual([
      // The unloading and the arrival share a minute: the unloading is the furthest along.
      ['2024-12-19T11:35:00', 'D1', 'COMPLETED UNLOADING AT DELIVERY LOCATION', 'delivered'],
      ['2024-12-19T11:35:00', 'X1', 'ARRIVED AT DELIVERY LOCATION', 'out_for_delivery'],
      ['2024-12-19T08:10:00', 'AJ', 'TENDERED FOR DELIVERY', 'out_for_delivery'],
      // A hand-over to a connecting line is no delivery.
      ['2024-12-19T08:10:00', 'J1', 'DELIVERED TO CONNECTING LINE', 'in_transit'],
      ['2024-12-16T14:25:00', 'X9', 'DELIVERY APPT SECURED ON DATE/TIME', 'in_transit'],
      // A delay names its late reason.
      ['2024-12-16T09:45:00', 'SD', 'SHIPMENT DELAYED: TRAP FOR CUSTOMER', 'exception'],
    ]);
    expect(events[0]).toEqual({ local_time: '2024-12-19T11:35:00', time: '2024-12-19T11:35:00-08:00', time_zone: 'America/Los_Angeles',
      time_zone_basis: 'place', location: 'Mount Vernon, WA', description: 'COMPLETED UNLOADING AT DELIVERY LOCATION', provider_code: 'D1',
      stage: 'delivered', stage_source: 'carrier_map' });
    // Oregon keeps a second zone in its east, so its rows keep their wall clocks alone.
    const oregon = events.filter((event) => event.location!.endsWith(', OR'));
    expect(oregon.map((event) => event.location)).toEqual(['Clackamas, OR', 'Clackamas, OR', 'Clackamas, OR', 'Central Point, OR', 'Central Point, OR']);
    expect(oregon.every((event) => event.time === undefined && event.time_zone === undefined)).toBe(true);
    // The carrier's capitals read as the page's towns.
    expect(events.at(-1)).toMatchObject({ local_time: '2024-12-10T15:08:00', location: 'Santee, CA', provider_code: 'X3', stage: 'registered',
      time: '2024-12-10T15:08:00-08:00' });
    expect(events.at(-2)).toMatchObject({ provider_code: 'AF', stage: 'accepted' });
    // The late reason of a row that is no delay is not kept.
    expect(JSON.stringify(result)).not.toMatch(/NORMAL STATUS|SHIPPER RELATED/);
  });

  it('dates no row after the read', () => {
    const events = parseBluegrace(fixture('delivered-ltl'), LTL, 'BOL', Date.parse('2024-12-19T19:00:00Z')).events!;
    expect(events[0]).toMatchObject({ local_time: '2024-12-19T11:35:00', provider_code: 'D1' });
    expect(events[0]).not.toHaveProperty('time');
    expect(events[2]).toMatchObject({ local_time: '2024-12-19T08:10:00', time: '2024-12-19T08:10:00-08:00' });
  });

  it('keeps the wall clocks of states with two zones, and finds no carrier to hand over to without a SCAC', () => {
    const truckload = parseBluegrace(fixture('truckload'), TRUCKLOAD, 'BOL');
    expect(truckload).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2023-08-07T13:08:36',
      last_status_text: 'Completed Unloading at Delivery Location', expected_delivery: null });
    expect(truckload).not.toHaveProperty('delivery_carrier');
    expect(truckload.events!.every((event) => event.time === undefined)).toBe(true);
    expect(truckload.events!.map((event) => [event.provider_code, event.location, event.stage])).toEqual([
      ['D1', 'Phoenix, AZ', 'delivered'],
      ['X1', 'Phoenix, AZ', 'out_for_delivery'],
      ['AF', 'Houston, TX', 'accepted'],
      ['XB', 'Houston, TX', 'registered'],
      ['XB', 'Houston, TX', 'registered'],
      ['XB', 'Houston, TX', 'registered'],
      ['X3', 'Houston, TX', 'registered'],
      // A row without its town keeps its state.
      ['XB', 'TX', 'registered'],
      ['XB', 'Houston, TX', 'registered'],
    ]);

    const split = parseBluegrace(fixture('split-state'), SPLIT, 'BOL');
    expect(split).toMatchObject({ status: 'delivered', last_update: null, last_update_local: '2025-07-31T14:32:00',
      delivery_carrier: 'aaa-cooper', delivery_tracking_number: '661164889' });
    // The unloading is listed before the arrival a minute earlier.
    expect(split.events!.map((event) => [event.provider_code, event.location, event.time ?? null])).toEqual([
      ['D1', 'Miami, FL', null],
      ['X1', 'Miami, FL', null],
      ['AV', 'Jacksonville, FL', null],
      ['AF', 'Morrisville, NC', '2025-07-25T15:26:00-04:00'],
      ['X3', 'Morrisville, NC', '2025-07-25T15:24:00-04:00'],
    ]);
  });

  it('gives a shipment still moving the tracking record’s estimate, else its newest estimate row’s day', () => {
    const moving = (change: (shipment: Shipment) => void = () => {}) => ltl((shipment) => {
      shipment.trackingInfo.details = shipment.trackingInfo.details.filter((detail) => !['D1', 'X1', 'AJ', 'J1'].includes(detail.trackStatusCode!));
      change(shipment);
    });
    expect(parseBluegrace(moving(), LTL, 'BOL')).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'DELIVERY APPT SECURED ON DATE/TIME', expected_delivery: '2024-12-19' });
    expect(parseBluegrace(moving((shipment) => { shipment.trackingInfo.estimatedDeliveryDate = null; }), LTL, 'BOL'))
      .toMatchObject({ expected_delivery: '2024-12-19' });
    expect(parseBluegrace(moving((shipment) => {
      shipment.trackingInfo.estimatedDeliveryDate = null;
      shipment.trackingInfo.details = shipment.trackingInfo.details.filter((detail) => detail.trackingDate! < '2024-12-18');
    }), LTL, 'BOL')).toMatchObject({ expected_delivery: '2024-12-17' });
    expect(parseBluegrace(moving((shipment) => {
      shipment.trackingInfo.estimatedDeliveryDate = null;
      shipment.trackingInfo.details = shipment.trackingInfo.details.filter((detail) => !['AG', 'AB'].includes(detail.trackStatusCode!));
    }), LTL, 'BOL')).toMatchObject({ expected_delivery: null });
  });

  it('reads en route to the delivery location as out for delivery in the consignee’s state, as the page does', () => {
    const enRoute = (state: string) => parseBluegrace(ltl((shipment) => {
      shipment.trackingInfo.details = [row('X6', 'EN ROUTE TO DELIVERY LOCATION', '2024-12-18T07:00:00', 'Mount Vernon', state)];
    }), LTL, 'BOL');
    expect(enRoute('WA')).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', events: [{ provider_code: 'X6', stage: 'out_for_delivery' }] });
    expect(enRoute('OR')).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', events: [{ provider_code: 'X6', stage: 'in_transit' }] });
  });

  it('stages a code outside the map by its wording, or not at all', () => {
    const only = (code: string, wording: string) => parseBluegrace(ltl((shipment) => {
      shipment.trackingInfo.details = [row(code, wording, '2024-12-18T07:00:00', 'SEATTLE', 'WA')];
    }), LTL, 'BOL');
    expect(only('A3', 'SHIPMENT RETURNED TO SHIPPER')).toMatchObject({ current_stage: 'returned', events: [{ stage: 'returned', stage_source: expect.stringMatching(/^wording:/) }] });
    const unstaged = only('ZZ', 'SAMPLE NOTE');
    expect(unstaged).toMatchObject({ status: 'unknown', last_status_text: 'SAMPLE NOTE', events: [{ provider_code: 'ZZ', location: 'Seattle, WA' }] });
    expect(unstaged).not.toHaveProperty('current_stage');
    expect(unstaged.events![0]).not.toHaveProperty('stage');
  });

  it('reads a shipment without rows as listed, with its carrier', () => {
    expect(() => parseBluegrace(ltl((shipment) => { shipment.trackingInfo.details = []; }), LTL, 'BOL')).toThrow(expect.objectContaining({
      kind: 'indeterminate', reason: 'listed', deliveryCarrier: 'xpo-ltl', deliveryTrackingNumber: PRO }));
    expect(() => parseBluegrace(ltl((shipment) => {
      shipment.trackingInfo.details = shipment.trackingInfo.details.filter((detail) => ['AG', 'AB'].includes(detail.trackStatusCode!));
    }), LTL, 'BOL')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('names the booked carrier only from the catalog and only by a PRO number of its own', () => {
    const handoff = (change: (shipment: Shipment) => void) => parseBluegrace(ltl(change), LTL, 'BOL');
    expect(handoff((shipment) => { shipment.carrier.scac = 'ZZZZ'; })).not.toHaveProperty('delivery_carrier');
    expect(handoff((shipment) => { shipment.carrier.scac = 'constructor'; })).not.toHaveProperty('delivery_carrier');
    expect(handoff((shipment) => { shipment.trackingInfo.pro = LTL; shipment.references = []; })).not.toHaveProperty('delivery_carrier');
    expect(handoff((shipment) => { shipment.trackingInfo.pro = ''; })).toMatchObject({ delivery_carrier: 'xpo-ltl', delivery_tracking_number: PRO });
    expect(handoff((shipment) => { shipment.references = [{ name: 'PRO', value: '968307805' }]; })).not.toHaveProperty('delivery_carrier');
  });

  it('accepts only the shipment asked for', () => {
    // A bill of lading must be the shipment's own.
    expect(() => parseBluegrace(fixture('delivered-ltl'), TRUCKLOAD, 'BOL')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBluegrace(fixture('delivered-ltl'), PRO, 'BOL')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBluegrace(fixture('delivered-ltl'), '96830780', 'PRO')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parseBluegrace(fixture('delivered-ltl'), PRO, 'PRO')).toMatchObject({ current_stage: 'delivered' });
    // Carriers reuse PRO numbers, so two shipments under one settle nothing; one listed twice does.
    const other = { ...fixture('delivered-ltl')[0]!, bol: 'BG000000001', carrier: { scac: 'RNLO' } };
    expect(() => parseBluegrace([other, ...fixture('delivered-ltl')], PRO, 'PRO'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(parseBluegrace([...fixture('delivered-ltl'), ...fixture('delivered-ltl')], PRO, 'PRO')).toMatchObject({ current_stage: 'delivered' });
    expect(parseBluegrace([other, ...fixture('delivered-ltl')], LTL, 'BOL')).toMatchObject({ delivery_carrier: 'xpo-ltl' });
    // BlueGrace's integration test record is no shipment.
    expect(() => parseBluegrace(fixture('integration-test'), '123456789', 'BOL')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBluegrace(fixture('not-found'), UNKNOWN, 'BOL')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('rejects a changed reply', () => {
    const detail = (change: (detail: Row) => void) => ltl((shipment) => change(shipment.trackingInfo.details[0]!));
    for (const [index, reply] of [
      {}, null, '[]', [null], [[]],
      Array.from({ length: 26 }, () => fixture('delivered-ltl')[0]),
      ltl((shipment) => { (shipment.trackingInfo as unknown as Record<string, unknown>).details = {}; }),
      ltl((shipment) => { (shipment as unknown as Record<string, unknown>).trackingInfo = []; }),
      ltl((shipment) => { (shipment as unknown as Record<string, unknown>).bol = 879578524; }),
      ltl((shipment) => { (shipment as unknown as Record<string, unknown>).addresses = {}; }),
      ltl((shipment) => { (shipment.trackingInfo.details as unknown[]).push('row'); }),
      detail((row) => { row.trackingDate = '2024-12-10 15:08'; }),
      detail((row) => { row.trackingDate = '2024-12-10T24:00:00'; }),
      detail((row) => { row.trackingDate = '2024-02-30T15:08:00'; }),
      detail((row) => { row.trackingDate = '2024-12-10T15:08:00Z'; }),
      detail((row) => { row.trackingDate = ''; }),
      detail((row) => { row.trackStatusCode = ''; }),
      detail((row) => { row.trackStatusCode = 'ACTUAL'; }),
      detail((row) => { row.trackStatus = ' '; }),
      detail((row) => { (row as unknown as Record<string, unknown>).city = 1; }),
      ltl((shipment) => { shipment.trackingInfo.estimatedDeliveryDate = 'soon'; }),
    ].entries()) {
      expect(() => parseBluegrace(reply, LTL, 'BOL'), String(index)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a refused nonce, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: (reference: string) => Response, page?: () => Response) => carrier(site(body, page)).track({ number: LTL });
    // WordPress refuses a nonce with HTTP 403 and `-1`; the page's nonce was fresh, so the site changed.
    await expect(lookup(() => html('-1', { status: 403 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => html('', { status: 403, headers: { 'cf-mitigated': 'challenge' } }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html(CLOUDFLARE, { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    // WordPress answers an action no plugin registers with HTTP 400 and `0`; a 404 or a redirect is a move too.
    await expect(lookup(() => html('0', { status: 400 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html('', { status: 302, headers: { Location: 'https://mybluegrace.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json([]), () => html('', { status: 301, headers: { Location: 'https://mybluegrace.com/' } })))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json([]), () => html('', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json([]), () => html(CLOUDFLARE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => html('<html><title>BlueGrace</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json({ success: false }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(() => json([]), () => html('<html><title>BlueGrace</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    // A refusal of the PRO lookup is no absence either.
    await expect(lookup((reference) => (reference === 'PRO' ? html('-1', { status: 403 }) : json([])))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the page as %s', async (status, kind) => {
      const fromPage = site(() => json(fixture('delivered-ltl')), () => new Response('', { status }));
      await expect(carrier(fromPage).track({ number: LTL })).rejects.toMatchObject({ kind });
      expect(fromPage).toHaveBeenCalledTimes(1);
    });

  it.each([[429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s from the lookup as %s', async (status, kind) => {
      const fromLookup = site(() => new Response('', { status }));
      await expect(carrier(fromLookup).track({ number: LTL })).rejects.toMatchObject({ kind });
      expect(fromLookup).toHaveBeenCalledTimes(2);
    });

  it('refuses what BlueGrace cannot look up, or a cancelled lookup, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['BG12', 'SAMPLE', `${LTL},${TRUCKLOAD}`, '0'.repeat(31), '0'.repeat(65)]) {
      await expect(carrier(fetcher).track({ number })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: LTL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeBluegraceNumber(' bg 879-578-524 ')).toBe(LTL);
  });

  it('tries a read that hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const { fetcher, ended } = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(fetcher).track({ number: LTL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(ended).toEqual([60, 120]);
  });

  it('declares no recognition: its bills of lading take the shape of other carriers’ numbers', () => {
    expect(carrier(vi.fn<typeof fetch>()).recognize).toBeUndefined();
  });

  it('routes a number filed under BlueGrace to the adapter', async () => {
    const fetcher = site(() => json(fixture('delivered-ltl')));
    const tracker = createTracker({ fetcher, providers: [], env: {} });
    await expect(tracker.track({ number: LTL, carrier: 'bluegrace-logistics' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bluegrace-logistics', source: 'bluegrace-logistics', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith(BLUEGRACE_API))).toBe(true);
  });
});

describe('BlueGrace Logistics status vocabulary', () => {
  it('records every code the map knows with the stage it gives, and the forecasts as gaps', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage?: string }[]) {
      const answer = statusMapAnswer({ carrier: 'bluegrace-logistics', providerCode: entry.code, description: entry.wording });
      // En route to the delivery location is staged by the row's state.
      if (entry.code === 'X6') expect(answer).toEqual({ kind: 'unknown' });
      else if (entry.stage) expect(answer, entry.code).toEqual({ kind: 'mapped', stage: entry.stage });
      else expect(answer, entry.code).toEqual({ kind: 'intentional_gap', note: expect.any(String) });
    }
  });

  it('leaves an unknown code to the shared rules', () => {
    expect(statusMap.stage('A3', 'shipment returned to shipper')).toBeUndefined();
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(bluegraceStage('J1', 'DELIVERED TO CONNECTING LINE')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(bluegraceStage('ZZ', 'SAMPLE NOTE')).toBeNull();
    expect(statusMapAnswer({ carrier: 'bluegrace-logistics', providerCode: 'ZZ', description: 'SAMPLE NOTE' })).toEqual({ kind: 'unknown' });
  });
});

import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { readLateRegistrations } from '../../core/result/registration.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { sameInstantIdentityPolicy } from '../../app.js';
import { adapter, SHOUWU_API, SHOUWU_PAGE, ShouwuTracker } from './adapter.js';
import { normalizeShouwuNumber, parseShouwu } from './parser.js';
import { isShouwuFlightBooked, shouwuStage, shouwuStatusLabel, shouwuStatusStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const DELIVERED = 'SWECN990000000001YQ';
const OTHER = 'SWECN990000000002YQ';
const UNKNOWN = 'SWECN990000000003YQ';

type Row = Record<string, unknown>;
type Entry = { order: Row; traces: Row[] };
type Reply = Row & { result: Row; data: Entry[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (change: (traces: Row[], order: Row, reply: Reply) => void) => {
  const reply = fixture('delivered');
  change(reply.data[0]!.traces, reply.data[0]!.order, reply);
  return reply;
};
const trace = (traceTime: unknown, traceDesc: unknown, traceLocation: unknown = null): Row => ({ traceTime, traceDesc, traceLocation, traceType: 'TRACE_TYPE_TAIL' });
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it.each([
  ['International transit', 'in_transit'],
  ['Failed delivery', 'failed_attempt'],
  ['In delivery', 'out_for_delivery'],
  ['Arrived at the origin international airport', 'in_transit'],
  ['Clearance processing completed - Import', 'in_transit'],
  ['Customs clearance is in progress', 'customs'],
  ['Goods leaving the operation center', 'in_transit'],
  ['International flight has arrived', 'in_transit'],
  ['Parcel arrived at exchange office', 'in_transit'],
  ['Shipment picked up', 'accepted'],
  // Colis Privé's notices, relayed while Shouwu's warehouse still has the parcel.
  ['Your parcel arrived at the shipping partner. It will be sent to Colis Privé.', 'accepted'],
  ['Your package is in transit to Colis Privé', 'accepted'],
  ['The shipment has been loaded onto the delivery vehicle', 'out_for_delivery'],
  ['Your package is being prepared by the sender and will be handed over to us soon', 'registered'],
  ['Accepted at USPS facility', 'in_transit'],
  ['Arrived at Post Office', 'in_transit'],
  ['Arrived at USPS facility', 'in_transit'],
  ['Departed USPS facility', 'in_transit'],
  ['In transit to next facility', 'in_transit'],
  ['In transit to destination facility', 'in_transit'],
  ['Goods leaving the operation center | The outbound scan at the operation center is complete.', 'in_transit'],
  ['Goods leaving the operation center | The shipment has been loaded onto the transport vehicle.', 'in_transit'],
  ['Shipment started the customs clearance process at origin | Export declaration data has been prepared.', 'in_transit'],
  ['The shipment has been loaded onto the delivery vehicle | Delivery to the recipient address is in progress.', 'out_for_delivery'],
  ['The shipment has been loaded onto the delivery vehicle | The courier has the shipment for delivery.', 'out_for_delivery'],
  ['The shipment has been loaded onto the delivery vehicle | The courier is heading to the delivery address.', 'out_for_delivery'],
  ['The shipment has been loaded onto the delivery vehicle | The delivery round is still open.', 'out_for_delivery'],
  ['The shipment has been loaded onto the delivery vehicle | The out-for-delivery scan is on record.', 'out_for_delivery'],
  ['The shipment has been loaded onto the delivery vehicle | The parcel is still out with the courier.', 'out_for_delivery'],
  ['The shipment has been loaded onto the delivery vehicle | The shipment is on the delivery route.', 'out_for_delivery'],
  ['The shipment has been loaded onto the delivery vehicle | The shipment has not been signed for.', 'out_for_delivery'],
  ['Delivered, Front Door/Porch -> Your item was delivered at the front door or porch at noon.', 'delivered'],
  ['On the way in transit, arriving on time -> Your package is moving within the USPS network.', 'in_transit'],
  ['On the way, Departed USPS facility -> Your item departed our USPS facility.', 'in_transit'],
  ['On the way, Arrived at USPS facility -> Your item arrived at our USPS facility in EXAMPLE TOWN IL DISTRIBUTION CENTER.', 'in_transit'],
] as const)('maps the Shouwu scan %s to %s', (wording, stage) => {
  const payload = changed((rows) => rows.splice(0, rows.length, trace(1775990469, wording)));
  expect(parseShouwu(payload, DELIVERED).events?.[0]).toMatchObject({
    description: wording, stage, stage_source: 'carrier_map',
  });
});

// Synthetic Chinese labels after La Poste's sentences, as Shouwu relays them.
it.each([
  ['FR, Votre envoi est en cours de traitement sur le site de tri local.,运输中', 'in_transit'],
  ['FR, Votre envoi est sur son site de distribution. Nous le préparons pour le mettre en livraison.,派送中', 'out_for_delivery'],
  ['FR, Votre envoi a été distribué dans la boîte à lettres.,已签收', 'delivered'],
  ['FR, Votre envoi a été distribué dans la boîte à lettres.', 'delivered'],
  ['FR, Votre envoi a été distribué.,已签收', 'delivered'],
] as const)('reads the French sentence Shouwu relays in %s', (wording, stage) => {
  const payload = changed((rows) => rows.splice(0, rows.length, trace(1775990469, wording)));
  expect(parseShouwu(payload, DELIVERED).events?.[0]).toMatchObject({
    description: wording, stage, stage_source: 'carrier_map',
  });
});

it('reads a pickup point arrival whatever carrier note follows it', () => {
  for (const wording of ['Arrived at pick-up point. Package available for collection.',
    'Arrived at pick-up point. Package available for collection., Carrier note: Waiting for you to pick-up']) {
    const payload = changed((rows) => rows.splice(0, rows.length, trace(1775990469, wording)));
    expect(parseShouwu(payload, DELIVERED).events?.[0]).toMatchObject({ stage: 'ready_for_pickup', stage_source: 'carrier_map' });
  }
});

it('reads a milestone title repeated as its description, and a note that repeats its scan, once', () => {
  for (const [twice, once, stage] of [
    ['Out for delivery Out for delivery', 'Out for delivery', 'out_for_delivery'],
    ['Received by local delivery company Received by local  delivery company', 'Received by local delivery company', 'in_transit'],
    ['Delivery attempt unsuccessful, Carrier note: Delivery attempt unsuccessful', 'Delivery attempt unsuccessful', 'failed_attempt'],
  ] as const) {
    const payload = changed((rows) => rows.splice(0, rows.length, trace(1775990469, twice)));
    expect(parseShouwu(payload, DELIVERED).events?.[0]).toMatchObject({ description: once, stage, stage_source: 'carrier_map' });
    const policy = sameInstantIdentityPolicy('shouwu', { supportsScanMatching: true });
    const scan = { stage, description: once, location: 'SAMPLE TOWN', providerCode: '' };
    expect(policy?.matches?.(scan, { ...scan, description: twice })).toBe(true);
  }
  // A title and another description, or a note of its own, stay as written.
  for (const wording of ['Shipment on the way Shipment departed', 'Delivery failed, Carrier note: Recipient absent']) {
    const payload = changed((rows) => rows.splice(0, rows.length, trace(1775990469, wording)));
    expect(parseShouwu(payload, DELIVERED).events?.[0]?.description).toBe(wording);
  }
});

it('leaves a relayed sentence the map has not seen to the shared wording rules', () => {
  const wording = 'FR, Votre envoi est en attente de dédouanement.,运输中';
  const payload = changed((rows) => rows.splice(0, rows.length, trace(1775990469, wording)));
  expect(parseShouwu(payload, DELIVERED).events?.[0]?.stage_source).not.toBe('carrier_map');
});

describe('Shouwu International HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ShouwuTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' swecn 9900-0000-0001 yq ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(url).toBe(SHOUWU_API);
    expect(JSON.parse(String(init.body))).toEqual({ strs: [DELIVERED] });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Origin: 'https://admin.shshouwu.com', Referer: SHOUWU_PAGE,
      'x-locale': 'zh-cn', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'shouwu', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered parcel’s scans as wall clocks on Beijing time, newest first, with their towns, its destination, and no address', () => {
    const result = parseShouwu(fixture('delivered'), DELIVERED);
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Front Door', last_update: null, last_update_local: '2026-04-17T01:39:12', expected_delivery: null,
      destination_country: 'US', events: expect.any(Array) });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-04-17T01:39:12', 'SAMPLE CITY, CA', 'Delivered, Front Door', 'delivered'],
      ['2026-04-16T16:15:14', 'SAMPLE CITY, CA', 'Out for Delivery', 'out_for_delivery'],
      // A place with a digit could be an address or name a postcode, and is not read.
      ['2026-04-16T06:05:28', undefined, 'Arrived at Sorting Facility', 'in_transit'],
      ['2026-04-13T14:20:00', 'EXAMPLE GATEWAY', 'Customs clearance completed', 'in_transit'],
      ['2026-04-12T18:41:09', 'Shanghai', 'Departed from origin airport', 'in_transit'],
      // The scan listed twice counts once.
      ['2026-04-11T10:00:12', '上海', '已出库', undefined],
      ['2026-04-10T17:30:45', undefined, '已入库', 'accepted'],
      ['2026-04-10T11:12:00', undefined, 'Sample Status Note', undefined],
    ]);
    expect(result.events!.every((event) => !('time' in event) && !('provider_code' in event))).toBe(true);
    const json = JSON.stringify(result);
    for (const excluded of ['Sample Road', '99999', 'Sample Desk', 'Sample status text', 'United States', 'TRACE_TYPE', 'TRACE_STATUS']) {
      expect(json).not.toContain(excluded);
    }
  });

  it('reads epoch seconds as numbers or digits, milliseconds as the page does, and checks every clock', () => {
    const result = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, trace('1776361152', 'Delivered'), trace(1776327314999, 'Out for Delivery'), trace(1776290728, 'Arrived at Sorting Facility'));
    }), DELIVERED);
    expect(result.events!.map((event) => event.local_time)).toEqual(['2026-04-17T01:39:12', '2026-04-16T16:15:14', '2026-04-16T06:05:28']);
    // Equal instants keep the reply's order, newest first.
    const tied = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, trace(1776361152, 'Delivered'), trace(1776361152, 'Out for Delivery'));
    }), DELIVERED);
    expect(tied.events!.map((event) => event.description)).toEqual(['Delivered', 'Out for Delivery']);
    // The page shows no time for an empty or zero value; such a row places nothing.
    const timeless = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, trace(null, 'Delivered'), trace(0, 'Delivered'), trace('', 'Delivered'), trace(1776327314, 'Out for Delivery'));
    }), DELIVERED);
    expect(timeless.events!.map((event) => event.description)).toEqual(['Out for Delivery']);
    for (const time of [-1776361152, 1776361152.5, 177636115, 17763611520, '2026-04-16 17:39:12', '1776361152s', true, {}]) {
      expect(() => parseShouwu(changed((traces) => { traces[0]!.traceTime = time; }), DELIVERED), String(time))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps scans of one instant in the carrier\'s order when it lists them oldest first', () => {
    const result = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, trace(1776290728, 'Arrived at Sorting Facility'), trace(1776327314, 'Out for Delivery'), trace(1776327314, 'Delivered'));
    }), DELIVERED);
    expect(result.events!.map((event) => event.description)).toEqual(['Delivered', 'Out for Delivery', 'Arrived at Sorting Facility']);
  });

  it('lets the tracker’s status decide, refined by the newest staged scan within what the status covers', () => {
    const staged = (status: unknown, traces: Row[]) => parseShouwu(changed((rows, order) => {
      order.traceStatus = status;
      rows.splice(0, rows.length, ...traces);
    }), DELIVERED);
    // In Transit covers the delivery round, Preparing the warehouse taking the parcel.
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1776327314, 'Out for Delivery'), trace(1775990469, 'Departed from origin airport')]))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1775990469, 'Departed from origin airport')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    // The page turns In Transit with the row Shouwu writes two hours after the order data, before
    // anyone has the parcel; a scan the map does not know may be the parcel moving.
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1776361152, 'Carrier received the shipment'), trace(1776353952, 'Shipment information received')]))
      .toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
        events: [{ stage: 'registered', stage_source: 'carrier_map' }, { stage: 'registered', stage_source: 'carrier_map' }] });
    // One written two days after the order data is the handover itself.
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1776353952 + 2 * 86_400, 'Carrier received the shipment'), trace(1776353952, 'Shipment information received')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map',
        events: [{ stage: 'accepted', stage_source: 'carrier_map' }, { stage: 'registered', stage_source: 'carrier_map' }] });
    // Without a receipt that moved it, the first arrival at a carrier facility is the acceptance; the next is on the way.
    const facility = (at: number) => trace(at, 'Shipment arrived at a carrier facility');
    const received = [trace(1776361152, 'Carrier received the shipment'), trace(1776353952, 'Shipment information received')];
    expect(staged('TRACE_STATUS_ON_THE_WAY', [facility(1776500000), ...received]))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', events: [{ stage: 'accepted' }, { stage: 'registered' }, { stage: 'registered' }] });
    expect(staged('TRACE_STATUS_ON_THE_WAY', [facility(1776600000), facility(1776500000), ...received]).events?.map((event) => event.stage))
      .toEqual(['in_transit', 'accepted', 'registered', 'registered']);
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1776361152, 'Carrier received the shipment'), trace(1776353952, 'Shipment information received'),
      trace(1776720000, 'Waybill printed at a partner depot')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(staged('TRACE_STATUS_READY', [trace(1775813445, '已入库')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'wording:language' });
    // The warehouse's own scans are the parcel at the warehouse, which Preparing covers.
    expect(staged('TRACE_STATUS_READY', [trace(1775990469, 'Package processing completed'), trace(1775813445, 'Arrival processing center')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map' });
    expect(staged('TRACE_STATUS_READY', [trace(1775990469, 'Departed from origin airport')]))
      .toMatchObject({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map' });
    expect(staged('TRACE_STATUS_FAILED', [trace(1776361152, 'Returned to sender'), trace(1776327314, 'Out for Delivery')]))
      .toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'wording:language' });
    expect(staged('TRACE_STATUS_FAILED', [trace(1776327314, 'Out for Delivery')]))
      .toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map' });
    // Shouwu's own rows take the parcel through the flight and the clearance abroad, and the
    // delivering partner's pickup from its depot there is no step back to a handover.
    expect(staged('TRACE_STATUS_ON_THE_WAY', [trace(1777710000, 'Your consignment has been picked up'), trace(1777540000, '已交仓扫描'),
      trace(1777450000, '清关完成'), trace(1777370000, '已落地，清关提货中'), trace(1777200000, '二程预计27号的航班'), trace(1777100000, '航班已飞'),
      trace(1776800000, '1013C，申报过港中'), trace(1776500000, 'Package processing completed')]))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
        events: [{ stage: 'in_transit' }, { stage: 'in_transit' }, { stage: 'in_transit' }, { stage: 'customs' }, { stage: 'in_transit' },
          { stage: 'in_transit' }, { stage: 'in_transit' }, { stage: 'accepted' }] });
    // Delivered is the end: no scan but a return refines it, and no instant dates it.
    const signed = staged('TRACE_STATUS_SIGNED', [trace(1776361152, 'Sample Status Note'), trace(1776327314, 'Out for Delivery')]);
    expect(signed).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Sample Status Note' });
    expect(signed).not.toHaveProperty('delivered_at');
    // A status the map does not know, or none, leaves the newest staged scan; a late booking record is no step back.
    for (const status of ['TRACE_STATUS_SAMPLE', null]) {
      expect(staged(status, [trace(1776361152, 'Shipment information received'), trace(1776327314, 'Out for Delivery')]), String(status))
        .toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map', last_status_text: 'Shipment information received' });
      const unstaged = staged(status, [trace(1776361152, 'Sample Status Note')]);
      expect(unstaged, String(status)).toMatchObject({ status: 'unknown', last_status_text: 'Sample Status Note' });
      expect(unstaged, String(status)).not.toHaveProperty('current_stage');
    }
  });

  it('reads the flight booked before it flies as a notice on the stage of the scan before it', () => {
    const read = parseShouwu(changed((rows, order) => {
      order.traceStatus = 'TRACE_STATUS_ON_THE_WAY';
      rows.splice(0, rows.length, trace(1777540000, 'Estimated time of take-off'), trace(1777450000, 'The shipment begins at the point of origin.'),
        trace(1777370000, 'The warehouse is currently processing the goods.'));
    }), DELIVERED);
    expect(read.events!.map((event) => [event.stage, event.stage_source])).toEqual([
      ['in_transit', 'none'], ['in_transit', 'carrier_map'], ['in_transit', 'carrier_map']]);
    expect(read).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map', last_status_text: 'Estimated time of take-off' });
  });

  it('reads a status without scans as a summary, and a parcel with neither as no history', () => {
    expect(parseShouwu(changed((traces, order) => { order.traceStatus = 'TRACE_STATUS_READY'; traces.splice(0); }), DELIVERED)).toEqual({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map', provider_code: 'TRACE_STATUS_READY',
      last_status_text: 'Preparing', last_update: null, expected_delivery: null, destination_country: 'US', summary_only: true, events: [] });
    expect(parseShouwu(changed((_traces, order, whole) => { delete (whole.data[0] as Row).traces; order.countryCodeTwo = 'United States'; }), DELIVERED))
      .toMatchObject({ current_stage: 'delivered', summary_only: true, last_status_text: 'Delivered' });
    for (const status of ['TRACE_STATUS_SAMPLE', null]) {
      expect(() => parseShouwu(changed((traces, order) => { order.traceStatus = status; traces.splice(0); }), DELIVERED), String(status))
        .toThrow(NoHistoryError);
    }
    // Rows without wording or a time place nothing.
    expect(() => parseShouwu(changed((traces, order) => {
      order.traceStatus = null;
      traces.splice(0, traces.length, trace(1776361152, ''), trace(1776361152, null), trace(null, 'Delivered'));
    }), DELIVERED)).toThrow(NoHistoryError);
  });

  it('reads only the tracker’s empty answer as not found, and only the entries naming the whole number asked', () => {
    expect(() => parseShouwu(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The reply names another number only.
    for (const number of [OTHER, `${DELIVERED}1`, DELIVERED.slice(1), '']) {
      expect(() => parseShouwu(changed((_traces, order) => { order.orderNo = number; }), DELIVERED), number)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    // Beside another number's entry, ours is read; the number is matched in capitals without spaces.
    const mixed = changed((_traces, _order, whole) => {
      whole.data.unshift({ order: { orderNo: OTHER, traceStatus: 'TRACE_STATUS_READY' }, traces: [trace(1776400000, 'Sample Status Note')] });
      whole.data[1]!.order.orderNo = 'swecn990000000001yq ';
    });
    expect(parseShouwu(mixed, DELIVERED)).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-04-17T01:39:12' });
    // Of two entries under the number, the one with the newest scan is the parcel.
    const twice = changed((_traces, _order, whole) => {
      whole.data.push({ order: { orderNo: DELIVERED, traceStatus: 'TRACE_STATUS_ON_THE_WAY' }, traces: [trace(1776400000, 'Departed from origin airport')] },
        { order: { orderNo: DELIVERED, traceStatus: 'TRACE_STATUS_READY' }, traces: [] });
    });
    expect(parseShouwu(twice, DELIVERED)).toMatchObject({ current_stage: 'in_transit', last_update_local: '2026-04-17T12:26:40' });
    expect(parseShouwu(twice, DELIVERED)).not.toHaveProperty('destination_country');
  });

  it('keeps a failed lookup apart, and rejects a changed reply', () => {
    for (const payload of [{ result: { code: 500 } }, { result: { code: 505, message: 'Content-Type not supported' } }, { result: { code: 1000 }, data: [] }]) {
      expect(() => parseShouwu(payload, DELIVERED), JSON.stringify(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    for (const change of [
      (_traces: Row[], order: Row) => { delete order.orderNo; },
      (_traces: Row[], order: Row) => { order.orderNo = 990000000001; },
      (_traces: Row[], order: Row) => { order.traceStatus = 7; },
      (_traces: Row[], order: Row) => { order.traceStatus = 'Delivered'; },
      (_traces: Row[], order: Row) => { order.countryCodeTwo = ['US']; },
      (traces: Row[]) => { traces[0]!.traceDesc = 7; },
      (traces: Row[]) => { traces[0]!.traceLocation = ['SAMPLE CITY']; },
      (traces: Row[]) => { traces.push('scan' as unknown as Row); },
      (traces: Row[]) => { traces.push(...Array.from({ length: 500 }, () => trace(1776290728, 'Arrived at Sorting Facility'))); },
      (_traces: Row[], _order: Row, whole: Reply) => { (whole.data[0] as Row).traces = {}; },
      (_traces: Row[], _order: Row, whole: Reply) => { (whole.data[0] as Row).order = null; },
      (_traces: Row[], _order: Row, whole: Reply) => { whole.data.push(null as unknown as Entry); },
      (_traces: Row[], _order: Row, whole: Reply) => { whole.data.push(...Array.from({ length: 20 }, () => ({ order: { orderNo: OTHER }, traces: [] }))); },
      (_traces: Row[], _order: Row, whole: Reply) => { delete (whole as Row).data; },
      (_traces: Row[], _order: Row, whole: Reply) => { (whole as Row).data = {}; },
      (_traces: Row[], _order: Row, whole: Reply) => { whole.result.code = '0'; },
      (_traces: Row[], _order: Row, whole: Reply) => { delete (whole as Row).result; },
    ]) expect(() => parseShouwu(changed(change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const payload of [null, [], 'reply', {}]) expect(() => parseShouwu(payload, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps the newest hundred scans of a long history and says it cut the rest', () => {
    const result = parseShouwu(changed((traces) => {
      traces.splice(0, traces.length, ...Array.from({ length: 120 }, (_, index) => trace(1775000000 + index * 60, 'Arrived at Sorting Facility')));
    }), DELIVERED);
    expect(result.events).toHaveLength(100);
    expect(result).toMatchObject({ history_truncated: true, last_update_local: '2026-04-01T09:32:20' });
  });

  it('keeps an unknown number, a failed lookup, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(JSON.stringify({ result: { code: 500 } }))).rejects.toMatchObject({ kind: 'indeterminate' });
    // The lookup answers every number with HTTP 200: a 404, as for a renamed route, or a redirect is a moved route.
    await expect(lookup(JSON.stringify({ status: 404, error: 'Not Found', path: '/order/PubOrder/getOrderTrace' }), { status: 404 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://admin.shshouwu.com/login.html' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>'))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><head><title>Attention Required! | Cloudflare</title></head></html>')).rejects.toMatchObject({ kind: 'challenge' });
    // The tracking page, or an empty body, in place of the reply.
    await expect(lookup('<!DOCTYPE html><html lang=en><head><title>包裹追踪</title></head></html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('refuses numbers Shouwu does not issue, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'SWECN99000000001YQ', 'SWECN9900000000011YQ', 'SWEUS990000000001YQ', 'SWECN990000000001', '990000000001', `SWECN${'0'.repeat(70)}YQ`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeShouwuNumber('swecn-990000-000001-yq')).toBe(DELIVERED);
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: DELIVERED }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.fetcher).toHaveBeenCalledTimes(2);
    // Half of the budget, then the retry until it ends.
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(256 * 1024 + 1)));
    await expect(carrier(large).track({ number: DELIVERED })).rejects.toThrow('unexpectedly large');
  });

  it('recognizes a number the tracker knows, and not one it does not know or Shouwu does not issue', async () => {
    const recognize = (body: string) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).recognize!(DELIVERED);
    await expect(recognize(text('delivered'))).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-04-17T01:39:12', finished: true });
    await expect(recognize(text('not-found'))).resolves.toEqual({ known: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).recognize!('SWECN99000000001YQ')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(recognize(JSON.stringify({ result: { code: 500 } }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('answers a lookup for a Shouwu number from its own tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SHOUWU_API
      ? reply(text('delivered')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'shouwu', source: 'shouwu', result: { current_stage: 'delivered', destination_country: 'US' } });
    expect(answer.result.events[0]).toMatchObject({ local_time: '2026-04-17T01:39:12', description: 'Delivered, Front Door' });
    expect(fetcher.mock.calls.filter(([url]) => String(url) === SHOUWU_API)).toHaveLength(1);
  });

  it('dates each Beijing wall clock on its place’s zone, so a flight out of Shanghai lasts as long as it did', async () => {
    const flown = changed((traces, order) => {
      order.countryCodeTwo = 'DE';
      traces.splice(0, traces.length, trace(1775950200, 'Arrived at airport of Destination', 'Frankfurt'),
        trace(1775930400, 'Departed from export airport', 'Shanghai'), trace(1775900000, 'Package processing completed'));
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SHOUWU_API
      ? reply(JSON.stringify(flown)) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'shouwu' }, { budgetMs: 3000 });
    expect(answer.result.events.map((event) => [event.local_time, event.time, event.time_zone, event.time_zone_basis])).toEqual([
      ['2026-04-12T07:30:00', '2026-04-12T07:30:00+02:00', 'Europe/Berlin', 'place'],
      ['2026-04-12T02:00:00', '2026-04-12T02:00:00+08:00', 'Asia/Shanghai', 'place'],
      // A scan without a place takes the clock of the nearest one that has one: in China, its instant is the epoch's.
      ['2026-04-11T17:33:20', '2026-04-11T17:33:20+08:00', 'Asia/Shanghai', 'neighbour'],
    ]);
  });

  it('keeps the epoch as the instant of an agent’s note, iMile’s rows and an agent’s rows under an airport, but not the airline’s', async () => {
    const abroad = changed((traces, order) => {
      order.countryCodeTwo = 'IT';
      // The agent's rows come a day after the airline's and the arrival, so that every row keeps its order.
      traces.splice(0, traces.length, trace(1775950200 + 86400, '【ROM 10】Shipment out for delivery.', 'IT'),
        trace(1775946600 + 86400, '<User not at home>', 'IT'), trace(1775943000 + 86400, '因中港查验延误，需安排新航班。', 'GB'),
        trace(1775939400 + 86400, 'Flight arrival', 'MXP'), { ...trace(1775935800, 'Arrived at airport of Destination', 'MXP'), traceType: 'TRACE_TYPE_HEAD' },
        trace(1775932200, 'Shipment arrived in the destination country', 'IT'), trace(1775928600, '其他 | Shipment Announced', 'GB'));
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SHOUWU_API
      ? reply(JSON.stringify(abroad)) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'shouwu' }, { budgetMs: 3000 });
    expect(answer.result.events.map((event) => [event.time, event.time_zone, event.time_zone_basis])).toEqual([
      ['2026-04-13T07:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['2026-04-13T06:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['2026-04-13T05:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['2026-04-13T04:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['2026-04-12T03:30:00+02:00', 'Europe/Rome', 'place'],
      ['2026-04-12T02:30:00+02:00', 'Europe/Rome', 'place'],
      // A partner's row in English under the destination's code keeps its place's clock.
      ['2026-04-12T01:30:00+01:00', 'Europe/London', 'place'],
    ]);
    expect(answer.result.last_update).toBe('2026-04-13T07:30:00+08:00');
  });

  it('keeps the epoch as the instant of a row under a country\'s code or without a place that was written before its wall clock there', async () => {
    // Live shape: a flight's arrival under US, written five hours after its epoch, read on New York's clock came thirteen hours after it.
    const written = changed((traces, order) => {
      order.countryCodeTwo = 'US';
      traces.splice(0, traces.length, { ...trace(1775950200, 'Out for Delivery', null), createTs: (1775950200 + 9000) * 1000 },
        { ...trace(1775939400, 'Flight arrival', 'US'), createTs: (1775939400 + 18000) * 1000 },
        { ...trace(1775932200, 'Currently undergoing customs clearance in the destination country', 'US'), createTs: (1775932200 + 259200) * 1000 },
        { ...trace(1775900000, 'Departed from export airport', 'Shanghai'), createTs: (1775900000 + 60) * 1000 });
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SHOUWU_API
      ? reply(JSON.stringify(written)) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'shouwu' }, { budgetMs: 3000 });
    expect(answer.result.events.map((event) => [event.time, event.time_zone, event.time_zone_basis])).toEqual([
      ['2026-04-12T07:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['2026-04-12T04:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      // Written days later, its wall clock may be New York's, but there it would come after the round out for delivery
      // and the flight's arrival read at their epochs: it is read at its epoch too.
      ['2026-04-12T02:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['2026-04-11T17:33:20+08:00', 'Asia/Shanghai', 'place'],
    ]);
  });

  it('reads a row under a code that names no country, as EU, against the destination\'s clock', async () => {
    // Live shape: customs and the flight's arrival under EU, written together three hours after the customs epoch;
    // read on Vienna's clock, customs would come three hours after it was written.
    const written = changed((traces, order) => {
      order.countryCodeTwo = 'AT';
      traces.splice(0, traces.length, { ...trace(1775950200, 'Currently processing import customs clearance', 'EU'), createTs: (1775950200 + 10800) * 1000 },
        { ...trace(1775935800, 'Flight Arrived', 'EU'), createTs: (1775950200 + 10800) * 1000 },
        { ...trace(1775900000, 'Departed from export airport', 'Shanghai'), createTs: (1775900000 + 60) * 1000 });
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SHOUWU_API
      ? reply(JSON.stringify(written)) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'shouwu' }, { budgetMs: 3000 });
    expect(answer.result.events.map((event) => [event.time, event.time_zone, event.time_zone_basis])).toEqual([
      ['2026-04-12T07:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      // Written after its wall clock in Vienna, which would still come after customs read at its epoch: read at its epoch too.
      ['2026-04-12T03:30:00+08:00', 'Asia/Shanghai', 'carrier'],
      ['2026-04-11T17:33:20+08:00', 'Asia/Shanghai', 'place'],
    ]);
  });


  it('reads the Spanish last mile\'s rows, in capitals without a place, as UTC\'s wall clocks', async () => {
    // Live shape: its manifest record came eight hours to the second before Shouwu's receipt of the order data in China.
    const rows = (country: string, change: (row: Row) => Row = (row) => row) => changed((traces, order) => {
      order.countryCodeTwo = country;
      traces.splice(0, traces.length, change({ ...trace(1775950200, 'IN DELIVERY', null), createTs: (1775950200 + 40000) * 1000 }),
        { ...trace(1775900000, 'Shipment information received', 'CN'), traceType: 'TRACE_TYPE_OPERATE' },
        change({ ...trace(1775900000 - 28800, 'MANIFESTED OR RECORDED', null), createTs: (1775900000 + 360000) * 1000 }));
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url) === SHOUWU_API
      ? reply(JSON.stringify(rows('ES'))) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'shouwu' }, { budgetMs: 3000 });
    expect(answer.result.events.map((event) => [event.time, event.time_zone, event.time_zone_basis])).toEqual([
      ['2026-04-12T07:30:00Z', 'UTC', 'carrier'],
      ['2026-04-11T17:33:20+08:00', 'Asia/Shanghai', 'place'],
      ['2026-04-11T09:33:20Z', 'UTC', 'carrier'],
    ]);
    // Another destination, a place, wording not in capitals or another feed keeps the wall clock.
    for (const [country, change] of [['FR', undefined], ['ES', (row: Row) => ({ ...row, traceLocation: 'Madrid' })],
      ['ES', (row: Row) => ({ ...row, traceDesc: 'In delivery' })], ['ES', (row: Row) => ({ ...row, traceType: 'TRACE_TYPE_HEAD' })]] as const) {
      const events = parseShouwu(rows(country, change), DELIVERED).events!;
      expect(events[0]!.time, `${country} ${String(change)}`).toBeUndefined();
      expect(events[0]!.local_time).toBe('2026-04-12T07:30:00');
    }
  });

});

describe('Shouwu International stored scans', () => {
  it.each(['Picked up', 'Arrived at FedEx location', 'Departed FedEx location'])(
    'stages the FedEx relay %s when it includes the depot', (status) => {
      const wording = `Sampleville, CA, US, 00000, ${status}`;
      const payload = changed((rows) => rows.splice(0, rows.length, trace(1775990469, wording)));
      expect(parseShouwu(payload, DELIVERED).events?.[0]).toMatchObject({
        description: status, stage: 'in_transit', stage_source: 'carrier_map',
      });
      expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: wording }))
        .toEqual({ kind: 'mapped', stage: 'in_transit' });
    });

  it('lets a scan abroad, stored at the instant its wall clock reads in Beijing, take over its row by wording and place', () => {
    const policy = sameInstantIdentityPolicy('shouwu', { supportsScanMatching: true });
    expect(policy).toMatchObject({ storedSources: ['shouwu'], requireProviderCode: false, matchEachScan: true,
      relabelledFrom: 'Asia/Shanghai', matchWallClock: true });
    const wall = (time: string, zone?: string) =>
      DateTime.fromISO(time, zone ? { zone } : { setZone: true }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(wall('2026-04-11T23:30:00Z', policy?.relabelledFrom)).toBe(wall('2026-04-12T07:30:00+02:00'));
    const scan = { stage: 'in_transit', description: 'Arrived at airport of Destination', location: 'Frankfurt', providerCode: '' };
    expect(policy?.matches?.(scan, { ...scan, description: ' arrived at  airport of destination ' })).toBe(true);
    for (const other of [{ ...scan, location: 'Shanghai' }, { ...scan, description: 'Departed from export airport' }]) {
      expect(policy?.matches?.(scan, other)).toBe(false);
    }
  });

  it('reads a place without the country\'s code it opens with, and lets the row stored with that code keep its identity', () => {
    const coded = changed((traces) => {
      traces.splice(0, traces.length, trace(1775900000, 'Package processing completed', 'CN,SWE Sample Sort Facility'));
    });
    expect(parseShouwu(coded, DELIVERED).events!.map((event) => event.location)).toEqual(['SWE Sample Sort Facility']);
    // The last mile's rows give an empty code before their town.
    const town = changed((traces) => {
      traces.splice(0, traces.length, trace(1775900000, 'arrival city', ',Sample Town'));
    });
    expect(parseShouwu(town, DELIVERED).events!.map((event) => event.location)).toEqual(['Sample Town']);
    const policy = sameInstantIdentityPolicy('shouwu', { supportsScanMatching: true });
    const scan = { stage: 'accepted', description: 'Package processing completed', location: 'SWE Sample Sort Facility', providerCode: '' };
    expect(policy?.matches?.(scan, { ...scan, location: 'CN,SWE Sample Sort Facility' })).toBe(true);
    for (const other of [{ ...scan, location: 'CN,SWE Other Sort Facility' }, { ...scan, location: 'CN,SWE Sample Sort Facility', description: 'Arrival processing center' }]) {
      expect(policy?.matches?.(scan, other)).toBe(false);
    }
  });

  it('reads FedEx\'s rows without the town, state, country and postcode before their wording, and lets the rows stored with them keep their identity', () => {
    const relayed = changed((traces) => {
      traces.splice(0, traces.length,
        trace(1_776_009_600, 'SAMPLE TOWN, TX, US, 00000, Delivered', 'US,TX,SAMPLE TOWN'),
        trace(1_775_923_200, 'SAMPLE HUB, CA, US, 00000-0000, Arrived at FedEx location', 'US,CA,SAMPLE HUB'),
        trace(1_775_919_600, 'SAMPLE HUB, CA, US, 00000, Picked up', 'US,CA,SAMPLE HUB'),
        trace(1_775_916_000, 'Delivered, Front Door, SAMPLE', 'US,CA,SAMPLE HUB'));
    });
    expect(parseShouwu(relayed, DELIVERED).events!.map((event) => [event.description, event.location, event.stage])).toEqual([
      ['Delivered', 'TX,SAMPLE TOWN', 'delivered'],
      ['Arrived at FedEx location', 'CA,SAMPLE HUB', 'in_transit'],
      // FedEx collecting the parcel from Shouwu's depot abroad, after the clearance: no handover from the sender.
      ['Picked up', 'CA,SAMPLE HUB', 'in_transit'],
      ['Delivered, Front Door, SAMPLE', 'CA,SAMPLE HUB', 'delivered'],
    ]);
    const policy = sameInstantIdentityPolicy('shouwu', { supportsScanMatching: true });
    const scan = { stage: 'in_transit', description: 'Arrived at FedEx location', location: 'CA,SAMPLE HUB', providerCode: '' };
    expect(policy?.matches?.(scan, { ...scan, description: 'SAMPLE HUB, CA, US, 00000, Arrived at FedEx location' })).toBe(true);
    for (const other of [{ ...scan, description: 'SAMPLE HUB, CA, US, 00000, Departed FedEx location' },
      { ...scan, location: 'TX,SAMPLE TOWN', description: 'SAMPLE HUB, CA, US, 00000, Arrived at FedEx location' }]) {
      expect(policy?.matches?.(scan, other)).toBe(false);
    }
  });
});

describe('Shouwu International numbers', () => {
  it('names Shouwu for SWECN, twelve digits and YQ', () => {
    expect(detectCarrierMatch(DELIVERED)).toMatchObject({ carrier: 'shouwu', confidence: 'high' });
  });
});

describe('Shouwu International status vocabulary', () => {
  it('reads the last mile\'s manifest record and its hubs, as its wording spells them, and leaves its stationed rows unmapped', () => {
    expect(shouwuStage('MANIFESTED OR RECORDED')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(shouwuStage('TRNSIT HUB')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(shouwuStage('DESTIN HUB')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(shouwuStage('Hand over to airline')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // Some lines close the wording with a full stop, and name the arrival abroad after the hand-over.
    expect(shouwuStage('Hand over to airline.')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(shouwuStage('Arrived at destination airport.')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(shouwuStage('Parcel has been delivered')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(statusMap.stage(null, 'shipment information received.')).toBe('registered');
    // The page still shows the parcel in transit beside it, and it names no delivery.
    expect(shouwuStage('End of shipment')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // The origin facility the parcel reaches after its pickup.
    expect(shouwuStage('Arrived at origin facility')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(shouwuStage('Departed from sort facility')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(shouwuStage('STATIONED SHIPMENT')).toBeNull();
    // The import released in the destination, and the delivering partner's towns on its way.
    for (const wording of ['Import Released', 'arrival city', 'leave the city']) {
      expect(shouwuStage(wording), wording).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    }
  });

  it("reads the partner's collection in China as the first scan in its hands, and its centre's and flight's departures as transit", () => {
    expect(shouwuStage('Arrive at the delivery location Picked up by Shipping Partner')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(shouwuStage('Cargo leaving the operation center')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(shouwuStage('Flight departed, package in transit')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });

  it('reads the order data and the booked delivery as registered, and the postal line through the offices of exchange as transit', () => {
    expect(shouwuStage('运单电子信息已收到')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(shouwuStage('The booking of the delivery is completed.')).toEqual({ stage: 'registered', source: 'carrier_map' });
    for (const wording of ['Arriving at the airport', 'Office of exchange pre-alert/posting', 'The flight has taken off', 'The flight arrives',
      'Customs clearance is completed', 'Received at office of exchange', 'Departed from office of exchange']) {
      expect(shouwuStage(wording), wording).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    }
    // The flight booked is a forecast, which keeps the stage of the scan before it.
    expect(shouwuStage('Scheduled flights')).toBeNull();
    expect(isShouwuFlightBooked('Scheduled flights')).toBe(true);
  });

  it("reads the last mile's first facility after the destination's customs as transit", () => {
    expect(shouwuStage('Processing at Origin Facility')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // The delivering partner's first hub after the clearance at destination is the way on, not an acceptance.
    for (const wording of ['Arrived at Origin Hub', 'Departed Origin Hub']) expect(shouwuStage(wording)).toEqual({ stage: 'in_transit', source: 'carrier_map' });
  });

  it('reads the last mile\'s return as on its way back, whatever reason it names', () => {
    expect(shouwuStage('Back to Sender for reason: refused by the recipient')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(statusMap.stage(null, 'back to sender for reason: sample reason')).toBe('exception');
    expect(shouwuStage('Failed delivery for reason: recipient was not at home')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(statusMap.stage(null, 'failed delivery for reason: sample reason')).toBe('failed_attempt');
    // The Spanish last mile's failed round, in its own words.
    expect(shouwuStage('Reparto fallido')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    // DHL's failed round, then its way to the outlet that keeps it, whichever outlet it names.
    expect(shouwuStage('The shipment could not be delivered, and the recipient has been notified.')).toEqual({ stage: 'failed_attempt', source: 'carrier_map' });
    expect(shouwuStage('The shipment is being brought to [Sample outlet].The earliest time when it can be picked up can be found on the notification card.'))
      .toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // A missort in the last mile is a delay: the parcel goes on to its round.
    expect(shouwuStage('Mis routed')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // Its partner collecting the parcel from the seller, right after the order data.
    expect(shouwuStage('Picked up by Shipping Partner')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    // Its ship's departure, after the export clearance.
    expect(shouwuStage('The ship has already set sail')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    // DPD's failed round with a wrong address joined: the parcel went back to the depot, not to the sender.
    expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null,
      description: 'Unfortunately we have not been able to deliver your parcel. Consignee address not correct.' })).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    // The last mile's station keeping the parcel after a failed delivery names no stage.
    for (const wording of ['STATIONED SHIPMENT', 'STATIONED LOCATED', 'Envío estacionado', 'Estacionado ubicado', 'Pendiente de extracción']) {
      expect(shouwuStage(wording), wording).toBeNull();
      expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: wording }), wording).toMatchObject({ kind: 'intentional_gap' });
    }
  });

  it('maps every status it recorded to the stage recorded for it, and keeps the page’s labels off scan wording', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string | null }[]) {
      if (!entry.code && entry.stage === null) {
        // The flight booked, a forecast: a notice on the stage of the scan before it.
        expect(shouwuStage(entry.wording), entry.wording).toBeNull();
        expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: entry.wording }), entry.wording)
          .toMatchObject({ kind: 'intentional_gap' });
        continue;
      }
      if (!entry.code) {
        // Scan wording recorded without a code.
        expect(shouwuStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
        expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: entry.wording }), entry.wording)
          .toEqual({ kind: 'mapped', stage: entry.stage });
        continue;
      }
      expect(shouwuStatusStage(entry.code), entry.code).toBe(entry.stage);
      expect(shouwuStatusLabel(entry.code), entry.code).toBe(entry.wording);
      expect(statusMap.stage(entry.code, ''), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'shouwu', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    // Shouwu's rows on a batch read alike whatever the batch, and its booked flight whatever the day.
    for (const wording of ['预计3号的航班', '二程预计27号的航班']) {
      expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: wording }), wording).toMatchObject({ kind: 'intentional_gap' });
    }
    for (const wording of ['0927A，申报过港中', '1101B,申报过港中',
      // And the partner's sort and departure in China, whatever the facility's town.
      'Arrived at Sort Facility GUANGZHOU', 'Departed Facility in HONG KONG']) {
      expect(shouwuStage(wording), wording).toEqual({ stage: 'in_transit', source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    expect(shouwuStage('预计航班')).toBeNull();
    // A hub named by its code, a terminal by its number, and a letterbox delivery whatever note follows it; a line with
    // or without its closing full stop.
    for (const [wording, stage] of [['Arrived at AB CENTER', 'in_transit'], ['The package has arrived at terminal (T2).', 'in_transit'],
      ['Delivered by Mailbox, Example note: No. If you have any questions, please contact the carrier', 'delivered'],
      ['Parcel received by local Facility', 'in_transit'], ['Parcel departed from facility.', 'in_transit'],
      ['Arrived at destination airport', 'in_transit'], ['Arrived at GOFO Regional Destination Facility', 'in_transit'],
      ['The driver is out for delivery', 'out_for_delivery'], ['Arrived At Warehouse', 'in_transit']] as const) {
      expect(shouwuStage(wording), wording).toEqual({ stage, source: 'carrier_map' });
    }
    // A delivering partner's warehouse on the way, as the app keys it.
    expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: 'arrived at warehouse' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // The delivering partner's data row is no step back once the parcel moved.
    const late = readLateRegistrations({ status: 'in_transit', last_status_text: '', last_update: null, expected_delivery: null, events: [
      { time: '2026-01-02T22:49:56Z', description: '其他 | Client Order Shipped', stage: 'registered', stage_source: 'carrier_map' },
      { time: '2026-01-02T12:40:18Z', description: 'Shipment arrived at a carrier facility', stage: 'in_transit', stage_source: 'carrier_map' }] });
    expect(late.events?.[0]).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
    // iMile, the delivering partner in Italy, opens its rows with its centre: its sentences read them whatever the centre.
    for (const [wording, stage] of [['【NAP 03】Arrived.', 'in_transit'], ['【NAP 03】Shipment out for delivery.', 'out_for_delivery'],
      ['【NAP 03】 Back To DS.', 'failed_attempt'], ['【Example Transit Center】Order Closed.', 'exception']] as const) {
      expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
    expect(statusMapAnswer({ carrier: 'shouwu', providerCode: null, description: 'Preparing' })).toEqual({ kind: 'unknown' });
    expect(statusMapAnswer({ carrier: 'shouwu', providerCode: 'TRACE_STATUS_SAMPLE', description: 'Sample Status Note' })).toEqual({ kind: 'unknown' });
    for (const wording of ['constructor', 'toString', 'Sample Status Note', 'Preparing']) expect(shouwuStage(wording), wording).toBeNull();
  });

  it("reads DHL's round that found no such recipient and its return, and its delivery after that as the return delivered to the sender", () => {
    const parsed = (status: string) => parseShouwu(changed((rows, order) => {
      order.traceStatus = status;
      rows.splice(0, rows.length, trace(1776900000, 'Shipment sent directly from parcel center to business customer'),
        trace(1776800000, 'The shipment has been processed in the parcel center of origin'),
        trace(1776700000, 'Shipment will be returned to origin-Bad address'), trace(1776699000, 'The recipient is unknown'),
        trace(1776600000, 'The shipment has been processed in the destination parcel center'));
    }), DELIVERED);
    for (const status of ['TRACE_STATUS_FAILED', 'TRACE_STATUS_SIGNED']) {
      expect(parsed(status), status).toMatchObject({ current_stage: 'returned', current_stage_source: 'carrier_map',
        events: [{ stage: 'returned' }, { stage: 'in_transit' }, { stage: 'exception' }, { stage: 'failed_attempt' }, { stage: 'in_transit' }] });
    }
    // Without a return before it, the same row is a delivery to a business recipient.
    expect(shouwuStage('Shipment sent directly from parcel center to business customer')).toEqual({ stage: 'delivered', source: 'carrier_map' });
  });
});

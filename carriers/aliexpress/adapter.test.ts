import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult, type CarrierResult } from '../../core/result/index.js';
import { adapter, CainiaoTracker, fetchCainiao, parseCainiaoTrackingResponse } from './adapter.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { statusMap } from './status.js';
import { locatePlace } from '../../places/index.js';

const folder = path.dirname(fileURLToPath(import.meta.url));
const carrier = JSON.parse(
  readFileSync(path.join(folder, 'carrier.json'), 'utf8'),
) as { capabilities: string[] };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(folder, 'fixtures', name), 'utf8'));
}

const CAINIAO_WRONG_NUMBER = 'LP00000000000000';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cainiao wrong-number handling', () => {
  it('recognizes LP references through matching HTTP activity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(fixture('delivered.json')));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!('LP00000000000001', { budgetMs: 1000 })).resolves.toEqual({ known: true, lastActivityAt: '2026-03-04T09:15:00.000Z' });
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('mailNos')).toBe('LP00000000000001');
    await expect(instance.recognize!('not a parcel')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not recognize empty internal pending modules or hide wrong identities', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ module: [{ mailNo: CAINIAO_WRONG_NUMBER, mailNoSource: 'INTERNAL', detailList: [] }] }))
      .mockResolvedValueOnce(jsonResponse({ module: [{ mailNo: 'LP11111111111111', detailList: [] }] }));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(instance.recognize!(CAINIAO_WRONG_NUMBER, { budgetMs: 1000 })).resolves.toEqual({ known: false, lastActivityAt: null });
    await expect(instance.recognize!(CAINIAO_WRONG_NUMBER, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'schema' });
  });
  it('maps a matching empty external module to a privacy-safe 404', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      module: [{
        mailNo: CAINIAO_WRONG_NUMBER,
        mailNoSource: 'EXTERNAL',
        detailList: [],
        privateMessage: 'Private upstream details',
      }],
      success: true,
    }));

    try {
      await fetchCainiao(CAINIAO_WRONG_NUMBER);
      throw new Error('Expected the lookup to fail');
    } catch (error) {
      expect(error).toMatchObject({ name: 'NotFoundError', status: 404, kind: 'not_found' });
      expect(String(error)).toContain('Cainiao could not locate the shipment');
      expect(String(error)).not.toContain('Private upstream details');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    const requested = new URL(String(fetcher.mock.calls[0]![0]));
    expect(requested.searchParams.get('mailNos')).toBe(CAINIAO_WRONG_NUMBER);
  });

  it('keeps a matching non-external empty shipment pending', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      module: [{
        mailNo: CAINIAO_WRONG_NUMBER,
        mailNoSource: 'INTERNAL',
        detailList: [],
      }],
      success: true,
    }));

    await expect(fetchCainiao(CAINIAO_WRONG_NUMBER)).resolves.toMatchObject({
      status: 'pending',
      last_status_text: '',
      events: [],
    });
  });

  it('rejects a response describing a different shipment', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      module: [{ mailNo: 'LP11111111111111', detailList: [] }],
      success: true,
    }));

    await expect(fetchCainiao(CAINIAO_WRONG_NUMBER)).rejects.toThrow('different shipment');
  });

  it('uses the environment fetcher the factory hands the tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      module: [{ mailNo: CAINIAO_WRONG_NUMBER, mailNoSource: 'INTERNAL', detailList: [] }],
    }));
    const global = vi.spyOn(globalThis, 'fetch');

    await expect(new CainiaoTracker({ fetcher }).fetch(CAINIAO_WRONG_NUMBER))
      .resolves.toMatchObject({ status: 'pending' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(global).not.toHaveBeenCalled();
  });
});

describe('Cainiao projection', () => {
  const delivered = parseCainiaoTrackingResponse(fixture('delivered.json'), 'LP00000000000001');
  const inTransit = parseCainiaoTrackingResponse(fixture('in-transit.json'), 'LP00000000000002');

  it('keeps the whole delivered journey and the partner handoff number', () => {
    expect(delivered).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-03-04T10:15:00+01:00',
      // A delivered parcel has no estimate left to show.
      expected_delivery: null,
      delivered_at: '2026-03-04T10:15:00+01:00',
      delivery_tracking_number: 'RA123456785CH',
    });
    expect(delivered.events?.map((event) => [event.description, event.stage])).toEqual([
      ['Delivered', 'delivered'],
      ['Out for delivery', 'out_for_delivery'],
      ['Import customs clearance success', 'in_transit'],
      ['Shipment accepted by the warehouse', 'registered'],
    ]);
  });

  it('keeps the origin scans of a journey longer than twenty events through normalization', () => {
    const intermediate = Array.from({ length: 23 }, (_, index) => ({
      actionCode: 'LH_ARRIVE', standerdDesc: `Transit scan ${index + 1}`,
    }));
    const latest = { actionCode: 'GTMS_SIGNED', standerdDesc: 'Delivered' };
    const origin = { actionCode: 'GWMS_ACCEPT', standerdDesc: 'Shipment accepted by the warehouse' };
    const result = normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', latestTrace: latest, detailList: [latest, ...intermediate, origin],
    }] }, 'LP00000000000001'));
    expect(result.events).toHaveLength(25);
    expect(result.events?.at(-1)).toMatchObject({
      provider_code: 'GWMS_ACCEPT', description: 'Shipment accepted by the warehouse', stage: 'registered',
    });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered' });
  });

  it('reads the town Cainiao writes before a scan\'s wording as its location', () => {
    expect(delivered.events?.map((event) => [event.location, event.description])).toEqual([
      ['Exampleville', 'Delivered'],
      ['Example City', 'Out for delivery'],
      ['', 'Import customs clearance success'],
      ['', 'Shipment accepted by the warehouse'],
    ]);
    const scan = (standerdDesc: string, carrier = 'Example Post') => parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', destCpInfo: { cpName: carrier },
      latestTrace: { actionCode: 'GTMS_ACCEPT', standerdDesc }, detailList: [{ actionCode: 'GTMS_ACCEPT', standerdDesc }],
    }] }, 'LP00000000000001');
    expect(scan("[Saint-Étienne-d'Exemple] Received by local delivery company")).toMatchObject({
      last_status_text: 'Received by local delivery company',
      events: [{ location: "Saint-Étienne-d'Exemple", description: 'Received by local delivery company' }],
    });
    // Codes, abbreviations, carrier names and a bracket alone are no place.
    for (const wording of ['[FR] Arrived', '[Fr] Arrived', '[GOFO] Arrived', '[Example Post] Arrived', '[Post(NL)] Arrived',
      '[Hub 12] Arrived', '[Exampleville]', 'Arrived [Exampleville]']) {
      expect(scan(wording).events?.[0]).toMatchObject({ location: '', description: wording });
      expect(scan(wording).last_status_text).toBe(wording);
    }
  });

  it('reads each scan at its own GMT offset and ignores the Beijing-based epoch', () => {
    // The fixture's epoch `time` values read timeStr as GMT+8, as the live API does.
    expect(delivered.events?.map((event) => event.time)).toEqual([
      '2026-03-04T10:15:00+01:00', '2026-03-04T07:02:00+01:00', '2026-03-02T19:40:00+01:00', '2026-02-25T09:00:00+08:00',
    ]);
    const scan = (timeZone?: string) => parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace: { actionCode: 'LH_ARRIVE', timeStr: '2026-06-10 07:40:00', timeZone, time: 1781048400000 }, detailList: [],
    }] }, 'LP00000000000001').last_update;
    expect(scan('GMT+5:30')).toBe('2026-06-10T07:40:00+05:30');
    expect(scan('GMT-5')).toBe('2026-06-10T07:40:00-05:00');
    expect(scan('GMT')).toBe('2026-06-10T07:40:00Z');
    // Without a zone the wall clock stays text rather than becoming the epoch's instant.
    expect(scan(undefined)).toBe('2026-06-10 07:40:00');
  });

  it('reads a zone-less notice that Cainiao recorded itself on the Beijing clock', () => {
    const scan = (timeStr: string, time: unknown, timeZone?: string) => ({ actionCode: 'LAST_MILE_ASN_NOTIFY', timeStr, time, timeZone });
    const departed = { actionCode: 'SC_OUTBOUND_SUCCESS', timeStr: '2026-06-10 07:39:39', timeZone: 'GMT+8', time: 1781048379000 };
    // The notice's epoch keeps milliseconds and renders to its timeStr in Beijing.
    const notice = scan('2026-06-10 07:40:16', 1781048416947, '');
    const result = parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace: notice, detailList: [notice, departed],
    }] }, 'LP00000000000001');
    expect(result.last_update).toBe('2026-06-10T07:40:16+08:00');
    expect(result.events?.map((event) => event.time)).toEqual(['2026-06-10T07:40:16+08:00', '2026-06-10T07:39:39+08:00']);
    const time = (latestTrace: unknown) => parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      latestTrace, detailList: [],
    }] }, 'LP00000000000001').last_update;
    expect(time(scan('2026-06-10 07:40:16', 1781048416947))).toBe('2026-06-10T07:40:16+08:00');
    // A whole-second epoch can be a reading of the text, and one that disagrees with it is no record of it.
    expect(time(scan('2026-06-10 07:40:16', 1781048416000, ''))).toBe('2026-06-10 07:40:16');
    expect(time(scan('2026-06-10 01:40:16', 1781048416947, ''))).toBe('2026-06-10 01:40:16');
    expect(time(scan('2026-06-10 07:40:16', '1781048416947', ''))).toBe('2026-06-10 07:40:16');
    // A zone the adapter cannot read is still a zone: it is not replaced by Beijing's.
    expect(time(scan('2026-06-10 07:40:16', 1781048416947, 'CET'))).toBe('2026-06-10 07:40:16');
  });

  it.each(['ra 123.456-785 ch', 'RA123456785CH'])('normalizes the machine-readable partner reference before host validation: %s', (reference) => {
    const result = normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      copyRealMailNo: reference, latestTrace: { actionCode: 'LH_ARRIVE' }, detailList: [],
    }] }, 'LP00000000000001'));
    expect(result.delivery_tracking_number).toBe('RA123456785CH');
    expect(result.delivery_carrier).toBeUndefined();
  });

  it('uses display prose only when the machine-readable reference is invalid', () => {
    const result = normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{ mailNo: 'LP00000000000001',
      copyRealMailNo: 'bad?number', realMailNo: 'Handover reference: ra123456785ch', detailList: [],
    }] }, 'LP00000000000001'));
    expect(result.delivery_tracking_number).toBe('RA123456785CH');
  });

  it('reports the estimate as a window while the parcel is still moving', () => {
    expect(inTransit).toMatchObject({
      status: 'in_transit',
      current_stage: 'in_transit',
      expected_delivery: '2026-03-12',
      expected_delivery_from: '2026-03-10',
    });
  });

  it('never reads a station signature as a delivery', () => {
    const result = parseCainiaoTrackingResponse({
      module: [{
        mailNo: 'LP00000000000003',
        latestTrace: { actionCode: 'GTMS_STA_SIGNED', standerdDesc: 'Arrived at the pickup station' },
        detailList: [{ actionCode: 'GTMS_STA_SIGNED', standerdDesc: 'Arrived at the pickup station' }],
      }],
    }, 'LP00000000000003');

    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup' });
    expect(result.events?.[0]?.stage).toBe('ready_for_pickup');
  });

  it('keeps each milestone stable as the parcel moves from customs to collection', () => {
    const journey = [
      ['PU_PICKUP_SUCCESS', 'Received by logistics company', 'accepted'],
      ['CC_EX_START', 'Export customs clearance started', 'customs'],
      ['CC_EX_SUCCESS', 'Export customs clearance complete', 'in_transit'],
      ['CC_HO_IN_SUCCESS', 'Arrived at customs', 'customs'],
      ['CC_IM_START', 'Import customs clearance started', 'customs'],
      ['CC_IM_SUCCESS', 'Import customs clearance complete', 'in_transit'],
      ['GTMS_DO_ARRIVE', 'Arrived at local delivery center', 'in_transit'],
      ['GTMS_STATION_OUT', 'Delivery in process. Now left facility.', 'in_transit'],
      ['GTMS_DO_DEPART', 'Out for delivery', 'out_for_delivery'],
      ['GTMS_STA_SIGNED', 'Arrived at pick-up point. Package available for collection.', 'ready_for_pickup'],
      ['GTMS_SIGNED', 'Package delivered', 'delivered'],
    ] as const;
    for (let index = 0; index < journey.length; index++) {
      const history = journey.slice(0, index + 1).reverse();
      const scans = history.map(([actionCode, standerdDesc]) => ({ actionCode, standerdDesc }));
      const result = normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{
        mailNo: 'LP00000000000001', latestTrace: scans[0], detailList: scans,
      }] }, 'LP00000000000001'));
      expect(result.current_stage).toBe(journey[index]![2]);
      expect(result.events?.map((event) => event.stage)).toEqual(history.map((row) => row[2]));
      for (const [code, wording, stage] of history) {
        expect(statusMap.stage(code, wording.toLowerCase())).toBe(stage);
      }
    }
  });

  it('places a numbered arrondissement while leaving facility codes and named carriers alone', () => {
    const project = (place: string, cpName = 'Example Post') => normalizeCarrierResult(parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', destCpInfo: { cpName }, latestTrace: { actionCode: 'GTMS_SIGNED' },
      detailList: [{ actionCode: 'GTMS_SIGNED', standerdDesc: `[${place}] Package delivered` }],
    }] }, 'LP00000000000001'));
    const event = project('PARIS 12E ARRONDISSEMENT').events?.[0];
    expect(event).toMatchObject({ location: 'PARIS 12E ARRONDISSEMENT', description: 'Package delivered' });
    expect(locatePlace(event!.location, { countries: ['FR'] })).toMatchObject({ country: 'FR', precision: 'city' });
    for (const place of ['HUB 12', 'PARIS 75012', 'GOFO', 'PARIS 99E ARRONDISSEMENT']) {
      expect(project(place).events?.[0]?.location).toBe('');
    }
    expect(project('PARIS 12E ARRONDISSEMENT', 'PARIS 12E ARRONDISSEMENT').events?.[0]?.location).toBe('');
  });

  it.each(['LP00000000000001', 'lp 00000000000001'])('does not advertise the queried number as a handoff: %s', (copyRealMailNo) => {
    expect(parseCainiaoTrackingResponse({ module: [{
      mailNo: 'LP00000000000001', copyRealMailNo, detailList: [],
    }] }, 'LP00000000000001')).not.toHaveProperty('delivery_tracking_number');
  });

  it('stages the legs between the linehaul and the local partner, and keeps every action code', () => {
    const scans = [
      ['GTMS_SC_DEPART', '[Exampleville] Departed from destination country/region sorting center'],
      ['TD_TRANS_ARRIVE_DCP', 'Awaiting for transit to final delivery office'],
      ['TD_TRANSWH_OUTBOUND', 'Leaving transit country/region'],
      ['LH_HO_OUT_SUCCESS', 'Handed over from linehaul office'],
      ['NEW_UNSEEN_CODE', 'Synthetic scan'],
    ];
    const reply = (detailList: Array<{ actionCode: string; standerdDesc: string }>) => parseCainiaoTrackingResponse({
      module: [{ mailNo: 'LP00000000000004', latestTrace: detailList[0], detailList }],
    }, 'LP00000000000004');
    const result = reply(scans.map(([actionCode, standerdDesc]) => ({ actionCode: actionCode!, standerdDesc: standerdDesc! })));
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(result.events?.map((event) => [event.provider_code, event.description, event.stage])).toEqual([
      ['GTMS_SC_DEPART', 'Departed from destination country/region sorting center', 'in_transit'],
      ['TD_TRANS_ARRIVE_DCP', 'Awaiting for transit to final delivery office', 'in_transit'],
      ['TD_TRANSWH_OUTBOUND', 'Leaving transit country/region', 'in_transit'],
      ['LH_HO_OUT_SUCCESS', 'Handed over from linehaul office', 'in_transit'],
      // An unknown code stays without a stage, and its code goes to review with the wording.
      ['NEW_UNSEEN_CODE', 'Synthetic scan', undefined],
    ]);
    expect(reply([{ actionCode: '', standerdDesc: 'Synthetic scan' }]).events?.[0]).not.toHaveProperty('provider_code');
  });
});

describe('Cainiao declared capabilities and privacy', () => {
  const results: CarrierResult[] = [
    parseCainiaoTrackingResponse(fixture('delivered.json'), 'LP00000000000001'),
    parseCainiaoTrackingResponse(fixture('in-transit.json'), 'LP00000000000002'),
  ];
  const checks: Record<string, (result: CarrierResult) => boolean> = {
    history: (result) => (result.events?.length ?? 0) > 0,
    location: (result) => (result.events ?? []).some((event) => Boolean(event.location)),
    eta: (result) => Boolean(result.expected_delivery),
    eta_window: (result) => Boolean(result.expected_delivery_from),
    sender_name: (result) => Boolean(result.sender_name),
    pickup_point: (result) => Boolean(result.pickup_point),
    weight: (result) => result.weight_kg != null,
    dimensions: (result) => Boolean(result.dimensions_text),
    delivered_at: (result) => Boolean(result.delivered_at),
    provider_code: (result) => (result.events ?? []).some((event) => Boolean(event.provider_code)),
  };

  it.each(carrier.capabilities)('declares %s and a fixture proves it', (capability) => {
    const check = checks[capability];
    expect(check, `unknown capability ${capability}`).toBeTypeOf('function');
    expect(results.some((result) => check!(result))).toBe(true);
  });

  it('drops the recipient identity the module carries', () => {
    const projected = JSON.stringify(results[0]);
    for (const value of ['Made Up Recipient', 'Example Street 1', 'proof-of-delivery', 'signPictureUrl']) {
      expect(projected).not.toContain(value);
    }
  });
});

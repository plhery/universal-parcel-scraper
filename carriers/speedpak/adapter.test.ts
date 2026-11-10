import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SpeedpakTracker } from './adapter.js';
import { normalizeSpeedpakNumber, parseSpeedpak } from './parser.js';
import { statusMap } from './status.js';

const NUMBER = 'ES0000000000000UN0000000000N';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));

describe('SpeedPAK response projection', () => {
  it('binds history and a labelled last-mile handoff to the requested shipment', () => {
    const result = parseSpeedpak(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', destination_country: 'US',
      delivery_carrier: 'uniuni', delivery_tracking_number: 'UUS00T0000000000000', delivered_at: '2026-01-03T17:00:00Z' });
    expect(result.events).toHaveLength(5);
    expect(result.events?.[0]).toMatchObject({ stage_source: 'carrier_map', location: 'Example City, US' });
    expect(JSON.stringify(result)).not.toContain('consigneeZipCode');
  });

  it.each(['different', 'missing', 'duplicate', 'contradictory'])('rejects %s shipment identity', mode => {
    const payload = fixture();
    if (mode === 'different') payload.result.waybills[0].trackingNumber = 'ES9999999999999UN0000000000N';
    if (mode === 'missing') delete payload.result.waybills[0].trackingNumber;
    if (mode === 'duplicate') payload.result.waybills.push(payload.result.waybills[0]);
    if (mode === 'contradictory') payload.result.notExistsTrackingNumbers.push(NUMBER);
    expect(() => parseSpeedpak(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires a matching negative reply and keeps empty replies indeterminate', () => {
    expect(() => parseSpeedpak({ success: true, result: { waybills: [], notExistsTrackingNumbers: [NUMBER] } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    for (const payload of [{ success: false }, { success: true, result: { waybills: [], notExistsTrackingNumbers: [] } }]) {
      expect(() => parseSpeedpak(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parseSpeedpak({ success: true, result: { waybills: [], notExistsTrackingNumbers: {} } }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unresolved newest clock without borrowing an older instant', () => {
    const payload = fixture(); payload.result.waybills[0].traces[0].oprTimestamp = 'unknown';
    const result = parseSpeedpak(payload, NUMBER);
    expect(result.last_update).toBeNull(); expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: '2026-01-03 12:00:00' });
    expect(result.events?.[0]?.time).toBeUndefined();
  });

  it('does not route from conflicting or unlabelled downstream references', () => {
    const payload = fixture(); payload.result.waybills[0].traces.push({ eventDesc: 'LM Carrier: [Uni Uni] , LM tracking No.：[UUS00T1111111111111]' });
    expect(parseSpeedpak(payload, NUMBER).delivery_tracking_number).toBeUndefined();
    payload.result.waybills[0].traces.splice(2, 1); payload.result.waybills[0].traces.pop();
    payload.result.waybills[0].traces.push({ eventDesc: 'Reference UUS00T0000000000000' });
    expect(parseSpeedpak(payload, NUMBER).delivery_tracking_number).toBeUndefined();
  });

  it('names PostNL for a hand-off to "Nl Post" with a PostNL reference', () => {
    const payload = fixture();
    for (const trace of payload.result.waybills[0].traces) {
      if (String(trace.eventDesc).startsWith('LM Carrier')) trace.eventDesc = 'LM Carrier: [Nl Post] , LM tracking No.：[RR000000005NL]';
    }
    expect(parseSpeedpak(payload, NUMBER)).toMatchObject({ delivery_carrier: 'spring-gds', delivery_tracking_number: 'RR000000005NL' });
  });

  it('classifies a last-mile carrier\'s wording by SpeedPAK\'s own Chinese label', () => {
    const payload = JSON.parse(readFileSync(new URL('./fixtures/last-mile.json', import.meta.url), 'utf8'));
    const result = parseSpeedpak(payload, 'EE0000000000000UN00000000G0N');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-10-03T14:42:25Z',
      delivery_carrier: 'usps', delivery_tracking_number: '9214490000000000000003' });
    expect(result.events?.map(event => event.stage)).toEqual([
      'delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered',
    ]);
  });

  it("reads SpeedX's attempt relayed without SpeedPAK's label as a failed attempt", () => {
    const payload = fixture();
    payload.result.waybills[0].traces[0] = { eventDesc: 'Attempted Delivery: No access', oprTimestamp: 1767362400000 };
    payload.result.waybills[0].lastStatus = 'Attempted Delivery: No access';
    const result = parseSpeedpak(payload, NUMBER);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'failed_attempt' });
    expect(result.events?.[0]).toMatchObject({ stage: 'failed_attempt', stage_source: 'carrier_map' });
    expect(statusMap.stage(null, 'attempted delivery: no access')).toBe('failed_attempt');
  });

  it("reads PF Logistics' onboard scan, relayed in quotes, as out for delivery", () => {
    const payload = fixture();
    payload.result.waybills[0].traces[0] = { eventDesc: '"Onboard ready for delivery"', eventDescCn: '尝试派送', oprTimestamp: 1767362400000 };
    payload.result.waybills[0].lastStatus = '"Onboard ready for delivery"';
    payload.result.waybills[0].lastStatusCn = '尝试派送';
    const result = parseSpeedpak(payload, NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(result.events?.[0]).toMatchObject({ stage: 'out_for_delivery', stage_source: 'carrier_map' });
    expect(statusMap.stage(null, '"onboard ready for delivery"')).toBe('out_for_delivery');
  });

  it('keeps a destination hand-off\'s departures and arrivals moving by their labels', () => {
    const payload = fixture();
    const traces = payload.result.waybills[0].traces;
    const later = traces[0].oprTimestamp;
    traces.splice(0, 0,
      { eventDesc: 'The consignment has reached the destination country', eventDescCn: '目的国小包收货确认', oprTimestamp: later + 3_000, oprCountry: 'US' },
      { eventDesc: 'Left the destination depot', eventDescCn: '离开分拨站点', oprTimestamp: later + 2_000, oprCountry: 'US' },
      // A generic transfer label carries a partner's pickups and failures alike, so its wording decides.
      { eventDesc: 'We were unable to deliver your parcel', eventDescCn: '包裹转运', oprTimestamp: later + 1_000, oprCountry: 'US' });
    const result = parseSpeedpak(payload, NUMBER);
    expect(result.events?.slice(0, 3).map(event => [event.stage, event.stage_source])).toEqual([
      ['in_transit', 'carrier_map'], ['in_transit', 'carrier_map'], [undefined, undefined],
    ]);
  });

  it('names a partner only when its detection offers the reference', () => {
    const payload = fixture();
    payload.result.waybills[0].traces[2].eventDesc = 'LM Carrier: [USPS] , LM tracking No.: [UUS00T0000000000000]';
    const result = parseSpeedpak(payload, NUMBER);
    expect(result.delivery_tracking_number).toBe('UUS00T0000000000000');
    expect(result.delivery_carrier).toBeUndefined();
  });

  it('tracks an EX number DHL Express carries, staged by its labels, and names DHL Express for the waybill', () => {
    const number = 'EX0000000000000DL00000000A0N';
    const scans: [string, string, string?][] = [
      ['Awaiting collection by the consignee', '等待收货人取货', 'IT'],
      ['Delivery attempted but no response at Consignee address', '无人在家', 'IT'],
      ['Shipment is out with courier for delivery', '由递送快递员携带', 'IT'],
      ['Arrived at DHL Delivery Facility  EXAMPLE CITY-ITALY', '到达配送中心', 'IT'],
      ['Clearance processing complete at EXAMPLE HUB-ITALY', '清关放行', 'IT'],
      ['Arrived at DHL Sort Facility  EXAMPLE HUB-ITALY', '到达操作中心', 'IT'],
      ['Shipment has departed from a DHL facility OSAKA-JAPAN', '离开操作中心', 'JP'],
      ['LM Carrier: [DHL] , LM tracking No.: [1234567891]', '尾程供应商信息'],
      ['Processed at OSAKA-JAPAN', '服务站已处理', 'JP'],
      ['Processed at OSAKA-JAPAN', '已取件', 'JP'],
      ['Order Created', '订单已创建', 'JP'],
    ];
    const traces = scans.map(([eventDesc, eventDescCn, oprCountry], index) => ({ eventDesc, eventDescCn, oprTimestamp: 1767362400000 - index * 3_600_000, ...(oprCountry ? { oprCountry } : {}) }));
    const payload = { success: true, result: { notExistsTrackingNumbers: [], waybills: [{ trackingNumber: number, consigneeCountryCode: 'IT',
      lastStatus: 'Awaiting collection by the consignee', lastStatusCn: '等待收货人取货', traces }] } };
    const result = parseSpeedpak(payload, number);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', destination_country: 'IT',
      delivery_carrier: 'dhl-express', delivery_tracking_number: '1234567891' });
    expect(result.events?.map(event => event.stage)).toEqual([
      'ready_for_pickup', 'failed_attempt', 'out_for_delivery', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered',
    ]);
    expect(normalizeSpeedpakNumber(number.toLowerCase())).toBe(number);
    expect(() => normalizeSpeedpakNumber(`EM${number.slice(2)}`)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'speedpak', confidence: 'high' });
  });

  it('rejects malformed scans and bounds history', () => {
    for (const row of [null, {}, { eventDesc: [] }]) {
      const payload = fixture(); payload.result.waybills[0].traces.unshift(row);
      expect(() => parseSpeedpak(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const payload = fixture(); payload.result.waybills[0].traces = Array.from({ length: 1001 }, () => payload.result.waybills[0].traces[0]);
    expect(() => parseSpeedpak(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('SpeedPAK retrieval', () => {
  it('uses one anonymous official request and passes cancellation through', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(fixture())));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await instance.track({ number: NUMBER });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://azure-cn.orangeconnex.com/oc/capricorn-website/website/v1/tracking/traces');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ trackingNumbers: [NUMBER], language: 'en-US' }) });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(normalizeSpeedpakNumber('es-0000000000000un0000000000n')).toBe(NUMBER);
  });

  it.each(['123', `${NUMBER},OTHER`, `${NUMBER}&query=OTHER`])('rejects invalid input %s without I/O', async number => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SpeedpakTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])('keeps HTTP %s separate from parcel absence', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Failure', { status: Number(status) }));
    await expect(new SpeedpakTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
  });

  it('honors an already aborted signal and limits streaming responses', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SpeedpakTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new SpeedpakTracker({ fetcher }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});

describe('SpeedPAK hand-off wording', () => {
  const routed = 'LM Carrier: [DHL eCommerce] , LM tracking No.: [420000009214490000000000000003]';
  const trimmed = 'LM Carrier: [DHL eCommerce] , LM tracking No.: [9214490000000000000003]';

  it('drops the ZIP code a USPS routing barcode opens with', () => {
    const payload = fixture();
    payload.result.waybills[0].traces[2] = { eventDesc: routed, eventDescCn: '尾程供应商:[DHL eCommerce] , 尾程跟踪号：[420000009214490000000000000003]', oprTimestamp: 1767362400000 };
    const result = parseSpeedpak(payload, NUMBER);
    expect(result.events?.[2]?.description).toBe(trimmed);
    // DHL eCommerce's detection does not offer the bare USPS number, so no partner is named.
    expect(result.delivery_tracking_number).toBe('9214490000000000000003');
    expect(result.delivery_carrier).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('42000000');
  });

  it('drops the ZIP code from the summary when the hand-off line is the newest scan', () => {
    const payload = fixture();
    payload.result.waybills[0].lastStatus = routed;
    const result = parseSpeedpak(payload, NUMBER);
    expect(result.last_status_text).toBe(trimmed);
    expect(JSON.stringify(result)).not.toContain('42000000');
  });

  it('reads the hand-off line as a movement without SpeedPAK\'s label, in English or Chinese', () => {
    const payload = fixture();
    expect(parseSpeedpak(payload, NUMBER).events?.[2]).toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
    payload.result.waybills[0].traces[2] = { eventDesc: '尾程供应商:[Uni Uni] , 尾程跟踪号：[UUS00T0000000000000]', oprTimestamp: 1767362400000 };
    expect(parseSpeedpak(payload, NUMBER).events?.[2]).toMatchObject({ stage: 'in_transit' });
    // As the summary, it is the parcel's stage until a later scan.
    payload.result.waybills[0].traces.splice(0, 2);
    payload.result.waybills[0].lastStatus = trimmed;
    expect(parseSpeedpak(payload, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    // A line without its reference names no hand-off.
    payload.result.waybills[0].traces[0].eventDesc = 'LM Carrier: [Uni Uni] , LM tracking No.: []';
    payload.result.waybills[0].lastStatus = 'LM Carrier: [Uni Uni] , LM tracking No.: []';
    expect(parseSpeedpak(payload, NUMBER)).toMatchObject({ status: 'unknown' });
  });

  it('lets a hand-off line stored with the routing barcode take the trimmed wording', () => {
    const policy = sameInstantIdentityPolicy('speedpak', { supportsScanMatching: true });
    expect(sameInstantIdentityPolicy('speedpak')).toBeUndefined();
    const stored = { stage: '', description: routed, location: '', providerCode: '' };
    const incoming = { ...stored, description: trimmed };
    expect(policy?.matches?.(incoming, stored)).toBe(true);
    // Nothing else: an unchanged scan, another place or another reference.
    expect(policy?.matches?.(incoming, incoming)).toBe(false);
    expect(policy?.matches?.(incoming, { ...stored, location: 'Example Hub, US' })).toBe(false);
    expect(policy?.matches?.({ ...incoming, description: trimmed.replace('0003]', '0004]') }, stored)).toBe(false);
  });

  it("shows SpeedPAK's Chinese sent as the English wording in English, and a partner's scan in the country it names as its city, not where it departs for", () => {
    const payload = fixture();
    const traces = payload.result.waybills[0].traces;
    const later = traces[0].oprTimestamp;
    traces.splice(0, 0,
      { eventDesc: '货物运输中', eventDescCn: '货物运输中', oprTimestamp: later + 4_000 },
      { eventDesc: 'DEPARTURE TO COUNTRY OF DESTINATION', eventDescCn: '', oprTimestamp: later + 3_000, oprCountry: 'FR' },
      { eventDesc: 'DEPARTURE TO COUNTRY OF DESTINATION', eventDescCn: '', oprTimestamp: later + 2_000, oprCity: 'BE', oprCountry: 'FR' },
      { eventDesc: 'PARCEL IS HANDLED', eventDescCn: '', oprTimestamp: later + 1_000, oprCity: 'BE', oprCountry: 'FR' });
    payload.result.waybills[0].lastStatus = '货物运输中';
    const result = parseSpeedpak(payload, NUMBER);
    expect(result).toMatchObject({ last_status_text: 'In transit', current_stage: 'in_transit' });
    expect(result.events?.[0]).toMatchObject({ description: 'In transit', stage: 'in_transit', stage_source: 'carrier_map' });
    // A departure for the destination country placed only in it has no place.
    expect(result.events?.[1]).toEqual(expect.not.objectContaining({ location: expect.anything() }));
    expect(result.events?.[2]).toMatchObject({ description: 'DEPARTURE TO COUNTRY OF DESTINATION', location: 'BE' });
    expect(result.events?.[3]).toMatchObject({ description: 'PARCEL IS HANDLED', location: 'BE' });
    // A town keeps its country.
    expect(result.events?.[4]).toMatchObject({ location: 'Example City, US' });
  });

  it('lets a row stored in Chinese, or with the destination after the code, take the English or the code alone', () => {
    const policy = sameInstantIdentityPolicy('speedpak', { supportsScanMatching: true });
    const chinese = { stage: 'in_transit', description: '货物运输中', location: '', providerCode: '' };
    expect(policy?.matches?.({ ...chinese, description: 'In transit' }, chinese)).toBe(true);
    expect(policy?.matches?.({ ...chinese, description: 'Arrival scan' }, chinese)).toBe(false);
    const placed = { stage: 'in_transit', description: 'PARCEL IS HANDLED', location: 'BE, FR', providerCode: '' };
    expect(policy?.matches?.({ ...placed, location: 'BE' }, placed)).toBe(true);
    expect(policy?.matches?.({ ...placed, location: 'FR' }, placed)).toBe(false);
    expect(policy?.matches?.({ ...placed, location: 'Example City' }, { ...placed, location: 'Example City, US' })).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { adapter } from './adapter.js';
import { JRT_ORIGIN, parseJrtPage, parseJrtTrack } from './parser.js';
import { isJrtDhlGermanRow, isJrtDhlRow, isJrtJtMexicoRow, statusMap } from './status.js';
import carrier from './carrier.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const REFERENCE = 'REFTEST000003';
const UP_REFERENCE = 'UP0000000000000002';
const READ_AT = Date.parse('2026-03-06T04:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('JRT tracking adapter', () => {
  it('finds an order without scans by the shipper’s reference on the page, after the interface has no row', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-registered')));
    const result = await adapter(environment(fetcher)).track({ number: REFERENCE });
    expect(result).toMatchObject({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'The electronic cargo information has been received',
      last_update: '2026-03-02T14:34:18+08:00', destination_country: 'CH', canonical_tracking_number: 'JRT0000000000ZZ',
    });
    expect(result.events).toEqual([
      { time: '2026-03-02T14:34:18+08:00', description: 'The electronic cargo information has been received', stage: 'registered', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toContain('Synthetic Recipient');
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${JRT_ORIGIN}/selectTrack.htm?documentCode=${REFERENCE}`, 'GET'],
      [`${JRT_ORIGIN}/trackIndex.htm`, 'POST'],
    ]);
    expect(JRT_ORIGIN).toBe('http://106.53.64.22:8082');
    expect(String(fetcher.mock.calls[1]![1]!.body)).toBe(`documentCode=${REFERENCE}`);
  });

  it('hands an order its page shows under DHL’s number to DHL, as the interface does', () => {
    const handed = page('page-registered').replaceAll('JRT0000000000ZZ', 'CJ000000005DE');
    const result = parseJrtPage(handed, REFERENCE, READ_AT);
    expect(result).toMatchObject({ delivery_carrier: 'dhl', delivery_tracking_number: 'CJ000000005DE' });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    // A number no rule claims for DHL is shown, and handed to no one.
    const other = parseJrtPage(page('page-registered').replaceAll('JRT0000000000ZZ', '000000000012'), REFERENCE, READ_AT);
    expect(other).toMatchObject({ delivery_tracking_number: '000000000012' });
    expect(other).not.toHaveProperty('delivery_carrier');
    expect(other).not.toHaveProperty('canonical_tracking_number');
  });

  it('reads JRT’s own number on the same page, and an unknown number as not found', async () => {
    expect(parseJrtPage(page('page-registered'), 'JRT0000000000ZZ', READ_AT).canonical_tracking_number).toBeUndefined();
    expect(parseJrtTrack(fixture('no-track'), 'JRT0000000000ZZ', READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: 'NOTFOUND000003' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads a parcel asked by its UP reference through the flights, the clearance and DHL’s copied rows', () => {
    const result = parseJrtTrack(fixture('track-dhl'), UP_REFERENCE, Date.parse('2026-03-15T00:00:00Z'))!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      // DHL's row beside the destination's code is on the destination's clock.
      last_status_text: 'loaded to movement / tour vehicle', last_update: '2026-03-14T16:11:00+01:00',
      destination_country: 'SE', service_name: '欧洲合成专线-A', canonical_tracking_number: 'JRT0000000002ZZ',
    });
    // Before the hand-off the record names neither a channel nor DHL's number, so nothing is handed over.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events?.map(({ description, stage, stage_source }) => [description, stage, stage_source])).toEqual([
      ['loaded to movement / tour vehicle', 'in_transit', 'carrier_map'],
      ['unloaded from movement / tour vehicle', 'in_transit', 'carrier_map'],
      ['the shipment has been processed in the parcel center of origin', 'in_transit', 'carrier_map'],
      ['已交服务商 Delivered to service provider', 'in_transit', 'carrier_map'],
      ['清关完成，卡车发运 Customs clearance completed; truck dispatched.', 'in_transit', 'carrier_map'],
      ['已提货，清关中 The goods have been picked up and are currently undergoing customs clearance', 'customs', 'carrier_map'],
      ['机场内等待提货，等待清关 Waiting for cargo pickup and customs clearance at the airport.', 'customs', 'carrier_map'],
      ['航班落地，拆板中 Flight landing, dismantling board in progress', 'in_transit', 'carrier_map'],
      ['航班起飞，以实际抵达为准 Flight departure subject to actual arrival time', 'in_transit', 'carrier_map'],
      // The flight the airport row books is still to come.
      ['Goods delivered to airport', 'in_transit', 'carrier_map'],
      ['货物已交机场,等待航班安排中 Cargo delivered to airport, pending flight arrangement', 'in_transit', 'carrier_map'],
      ['the instruction data for this shipment have been provided by the sender to dhl electronically', 'registered', 'carrier_map'],
      // The rows JRT words only in Chinese show the English of the platform's other tenants.
      ['Goods leave the operation center', 'in_transit', 'carrier_map'],
      ['Arrived at the receiving point', 'accepted', 'carrier_map'],
      ['The electronic cargo information has been received', 'registered', 'carrier_map'],
    ]);
    expect(JSON.stringify(result)).not.toContain('Synthetic Recipient');
  });

  it('reads an order handed over by JRT’s own number, which the record no longer holds, and hands it to DHL or FedEx', () => {
    const readAt = Date.parse('2026-03-15T00:00:00Z');
    const handed = (trackingNumber: string, extra: Record<string, unknown>[] = [], fields: Record<string, unknown> = {}) => {
      const payload = fixture('track-dhl') as { data: Record<string, unknown>[] }[];
      Object.assign(payload[0]!.data[0]!, { trackingNumber, ...fields });
      payload[0]!.data.push(...extra);
      return payload;
    };
    const dhl = parseJrtTrack(handed('CJ000000005DE'), 'JRT0000000002ZZ', readAt)!;
    expect(dhl).toMatchObject({ status: 'in_transit', delivery_carrier: 'dhl', delivery_tracking_number: 'CJ000000005DE' });
    expect(dhl.events).toHaveLength(15);
    expect(dhl).not.toHaveProperty('canonical_tracking_number');
    // Asked by the shipper's reference, the delivery carrier's number is no JRT number either.
    expect(parseJrtTrack(handed('CJ000000005DE'), UP_REFERENCE, readAt)).not.toHaveProperty('canonical_tracking_number');
    // A number no rule claims for DHL is shown, and handed to no one.
    const other = parseJrtTrack(handed('000000000012'), 'JRT0000000002ZZ', readAt)!;
    expect(other).toMatchObject({ delivery_tracking_number: '000000000012' });
    expect(other).not.toHaveProperty('delivery_carrier');
    // The line to Ireland names FedEx in its product: FedEx takes a number its detection offers it.
    const ireland = { productKindName: '爱尔兰合成FEDEX-A', consigneeCountry: 'IE' };
    expect(parseJrtTrack(handed('000000000011', [], ireland), 'JRT0000000002ZZ', readAt))
      .toMatchObject({ delivery_carrier: 'fedex', delivery_tracking_number: '000000000011', destination_country: 'IE' });
    expect(parseJrtTrack(handed('000000000012', [], ireland), 'JRT0000000002ZZ', readAt)).not.toHaveProperty('delivery_carrier');
    // Another JRT number, a second record or a reference the record does not hold is still another shipment.
    expect(() => parseJrtTrack(handed('JRT0000000009ZZ'), 'JRT0000000002ZZ', readAt)).toThrow('another shipment');
    expect(() => parseJrtTrack(handed('CJ000000005DE', [{ trackingNumber: 'CJ000000004DE' }]), 'JRT0000000002ZZ', readAt)).toThrow('another shipment');
    expect(() => parseJrtTrack(handed('CJ000000005DE'), 'UP0000000000000009', readAt)).toThrow('another shipment');
  });

  it('reads the landing, the clearance and the hand-over in Germany after DHL’s label data as transit', () => {
    const payload = fixture('track-dhl') as { data: { trackDetails: Record<string, string>[] }[] }[];
    const record = payload[0]!.data[0]!;
    const row = (track_date: string, track_content: string) => ({ ...record.trackDetails.at(-1)!, track_date, track_createdate: track_date, track_content, track_location: 'AMS' });
    // The rows JRT writes once the flight lands, newest first, above DHL's label data.
    record.trackDetails = [
      row('2026-03-07 10:00:00', '抵达德国，已交服务商'),
      row('2026-03-06 18:00:00', '清关完成，中转德国中'),
      row('2026-03-06 09:00:00', '航班已抵达'),
      ...record.trackDetails.slice(record.trackDetails.findIndex(({ track_content }) => track_content?.startsWith('the instruction data'))),
    ];
    const result = parseJrtTrack(payload, UP_REFERENCE, Date.parse('2026-03-08T00:00:00Z'))!;
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived in Germany, handed to the delivering carrier' });
    expect(result.events?.slice(0, 3).map(({ description, stage }) => [description, stage])).toEqual([
      ['Arrived in Germany, handed to the delivering carrier', 'in_transit'],
      ['Customs cleared, in transit to Germany', 'in_transit'],
      ['Flight has arrived', 'in_transit'],
    ]);
  });

  it('keeps the parcel in transit under DHL’s preferred-location note, which moves nothing', () => {
    const payload = fixture('track-dhl') as { data: { trackDetails: Record<string, string>[] }[] }[];
    const record = payload[0]!.data[0]!;
    record.trackDetails.unshift({ ...record.trackDetails[0]!, track_date: '2026-03-14 18:00:00', track_createdate: '2026-03-14 18:00:00',
      track_content: 'A preferred location was designated as a reception option for this shipment.' });
    const result = parseJrtTrack(payload, UP_REFERENCE, Date.parse('2026-03-15T00:00:00Z'))!;
    expect(result.events?.[0]).toMatchObject({ stage: 'pending' });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
  });

  it('reads the Shenzhen hub’s receipt after the operation center as transit, in English', () => {
    const payload = fixture('track-dhl') as { data: { trackDetails: Record<string, string>[] }[] }[];
    const record = payload[0]!.data[0]!;
    const row = (track_date: string, track_content: string) => ({ ...record.trackDetails.at(-1)!, track_date, track_createdate: track_date, track_content, track_location: '' });
    record.trackDetails = [row('2026-03-02 16:05:45', '深圳集散中心 已收货'), row('2026-03-01 15:21:17', '货物离开操作中心')];
    const result = parseJrtTrack(payload, UP_REFERENCE, Date.parse('2026-03-03T00:00:00Z'))!;
    expect(result.events?.map(({ description, stage }) => [description, stage])).toEqual([
      ['Received at the Shenzhen distribution center', 'in_transit'],
      ['Goods leave the operation center', 'in_transit'],
    ]);
  });

  it('reads UPS’s rows on the line into the United States on UPS’s wall clock, in UPS’s English', () => {
    const result = dateLocalClocks('jrt', parseJrtTrack(fixture('track-ups'), 'UP0000000000000003', Date.parse('2026-03-22T00:00:00Z'))!);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2026-03-20T16:02:46-04:00', canonical_tracking_number: 'JRT0000000003ZZ',
    });
    expect(result.events?.map(({ time, time_zone_basis, description, stage }) => [time, time_zone_basis, description, stage])).toEqual([
      ['2026-03-20T16:02:46-04:00', 'place', 'Delivered', 'delivered'],
      ['2026-03-20T09:31:18-04:00', 'place', 'Out For Delivery Today', 'out_for_delivery'],
      ['2026-03-20T06:29:43-04:00', 'place', 'Loaded on Delivery Vehicle', 'out_for_delivery'],
      ['2026-03-20T06:24:07-04:00', 'place', 'Processing at UPS Facility', 'in_transit'],
      ['2026-03-20T05:27:00-04:00', 'place', 'Arrived at Facility', 'in_transit'],
      ['2026-03-19T15:40:00-04:00', 'place', 'Departed from Facility', 'in_transit'],
      ['2026-03-19T05:38:00-04:00', 'place', 'Arrived at Facility', 'in_transit'],
      // UPS's row without a place takes the clock of the facility before it.
      ['2026-03-18T10:27:31-05:00', 'neighbour', 'Picked Up', 'in_transit'],
      ['2026-03-18T07:08:00-05:00', 'place', 'Departed from Facility', 'in_transit'],
      ['2026-03-17T17:42:11-05:00', 'place', 'Arrived at Facility', 'in_transit'],
      // JRT's own rows stay on the platform's clock.
      ['2026-03-17T08:20:04+08:00', undefined, 'Handed over to the warehouse', 'in_transit'],
      ['2026-03-16T07:30:50+08:00', undefined, 'Customs clearance completed, goods picked up, awaiting hand-over to the warehouse', 'in_transit'],
      ['2026-03-15T06:25:35+08:00', undefined, 'Picking up the goods', 'in_transit'],
      ['2026-03-14T05:20:26+08:00', undefined, 'Flight has arrived', 'in_transit'],
      ['2026-03-13T22:44:52+08:00', undefined, 'Flight has flown', 'in_transit'],
      ['2026-03-12T19:23:51+08:00', undefined, 'Booked on a flight', 'in_transit'],
      ['2026-03-10T01:03:15-04:00', 'place', 'Shipper created a label, UPS has not received the package yet.', 'registered'],
      ['2026-03-07T17:57:36+08:00', undefined, 'The electronic cargo information has been received', 'registered'],
    ]);
  });

  it('reads J&T Express Mexico’s rows on the line into Mexico on J&T’s clock in Mexico City', () => {
    const payload = fixture('track-dhl') as { data: Record<string, unknown>[] }[];
    const record = payload[0]!.data[0]! as { trackDetails: Record<string, string>[] } & Record<string, unknown>;
    const template = record.trackDetails.at(-1)!;
    const row = (track_date: string, track_location: string, track_content: string) => ({ ...template, track_date, track_createdate: '2026-11-09 15:21:56',
      track_location, track_content: track_location ? `${track_location}, ${track_content}` : track_content });
    Object.assign(record, { trackingNumber: 'JMX000000000001', consigneeCountry: 'MX' });
    record.trackDetails = [
      row('2026-11-08 00:05:28', 'Centro, Villa Uno, México', '【Villa Uno】Tu envío ha salido de【MEXICO.sc】con destino a【SUR-CENTRO.cedis】'),
      row('2026-11-07 23:57:42', 'Centro, Villa Uno, México', '【Villa Uno】Tu envío ha llegado a【MEXICO.sc】'),
      row('2026-11-07 20:55:52', 'Norte, Villa Dos, México', '【Villa Dos】【CLC-Norte.pdv】?Recolección exitosa!. El mensajero de J&T asignado CLC-NORTE1 recolectó tu envío. Si requieres mayor información, contáctanos al: 5500000000'),
      row('2026-11-07 00:00:00', '', 'Customs clearance in destination country completed'),
      row('2026-11-05 00:00:00', '', 'and the package has been handed over to customs for clearance'),
    ];
    const result = parseJrtTrack(payload, UP_REFERENCE, Date.parse('2026-11-09T08:00:00Z'))!;
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update: '2026-11-08T00:05:28-06:00' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events?.map(({ time, time_zone, time_zone_basis, location, stage }) => [time, time_zone, time_zone_basis, location, stage])).toEqual([
      // The night's sorting at J&T's centre, on its clock: read on Beijing's, it would fall fourteen hours early.
      ['2026-11-08T00:05:28-06:00', 'America/Mexico_City', 'carrier', 'Centro, Villa Uno, México', 'in_transit'],
      ['2026-11-07T23:57:42-06:00', 'America/Mexico_City', 'carrier', 'Centro, Villa Uno, México', 'in_transit'],
      // J&T's collection of the cleared parcel is no first acceptance.
      ['2026-11-07T20:55:52-06:00', 'America/Mexico_City', 'carrier', 'Norte, Villa Dos, México', 'in_transit'],
      // JRT's own rows stay on the platform's clock, the completed clearance in transit.
      ['2026-11-07T00:00:00+08:00', undefined, undefined, undefined, 'in_transit'],
      ['2026-11-05T00:00:00+08:00', undefined, undefined, undefined, 'customs'],
    ]);
    expect(result.events?.[2]?.description).toBe('【Villa Dos】【CLC-Norte.pdv】?Recolección exitosa!. El mensajero de J&T asignado CLC-NORTE1 recolectó tu envío. Si requieres mayor información, contáctanos al: 5500000000');
  });

  it('reads DHL’s rows copied without a place on DHL’s wall clock, in Germany and then at the destination', async () => {
    const readAt = Date.parse('2026-03-15T00:00:00Z');
    const result = dateLocalClocks('jrt', parseJrtTrack(fixture('track-dhl-placeless'), 'UP0000000000000004', readAt)!);
    expect(result).toMatchObject({
      status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment could not be delivered. Please find more information here.',
      last_update: '2026-03-12T16:35:00+01:00', destination_country: 'IT', delivery_carrier: 'dhl', delivery_tracking_number: 'CJ000000005DE',
    });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events?.map(({ time, local_time, time_zone, time_zone_basis, location, description, stage }) => [
      time, local_time, time_zone, time_zone_basis, location, description, stage,
    ])).toEqual([
      // DHL's rows at the destination, on its clock: DHL's own reply gives the same wall clocks there.
      ['2026-03-12T16:35:00+01:00', '2026-03-12T16:35:00', 'Europe/Rome', 'destination', undefined,
        'The shipment could not be delivered. Please find more information here.', 'failed_attempt'],
      ['2026-03-12T08:21:00+01:00', '2026-03-12T08:21:00', 'Europe/Rome', 'destination', undefined,
        'The shipment is being prepared for delivery in the delivery depot', 'in_transit'],
      ['2026-03-11T20:11:00+01:00', '2026-03-11T20:11:00', 'Europe/Rome', 'destination', undefined,
        'The shipment has been processed in the parcel center', 'in_transit'],
      ['2026-03-11T20:10:00+01:00', '2026-03-11T20:10:00', 'Europe/Rome', 'destination', undefined,
        'The shipment has arrived at the parcel center.', 'in_transit'],
      // DHL's rows in Germany, on its German clock.
      ['2026-03-10T09:14:00+01:00', '2026-03-10T09:14:00', 'Europe/Berlin', 'carrier', undefined,
        'The shipment will be transported to the destination country/destination area and, from there, handed over to the delivery organization.', 'in_transit'],
      ['2026-03-10T09:09:00+01:00', '2026-03-10T09:09:00', 'Europe/Berlin', 'carrier', undefined,
        'The international shipment has been processed in the export parcel center', 'in_transit'],
      ['2026-03-09T02:16:00+01:00', '2026-03-09T02:16:00', 'Europe/Berlin', 'carrier', undefined,
        'The international shipment has been processed in the parcel center of origin', 'in_transit'],
      // JRT's own rows stay on the platform's clock.
      ['2026-03-08T14:12:52+08:00', undefined, undefined, undefined, undefined, 'Delivery to final service provider', 'in_transit'],
      ['2026-03-08T12:12:43+08:00', undefined, undefined, undefined, undefined, 'In transit to final service provider', 'in_transit'],
      ['2026-03-08T09:12:00+08:00', undefined, undefined, undefined, undefined, 'Customs clearance completed', 'in_transit'],
      ['2026-03-07T08:11:01+08:00', undefined, undefined, undefined, undefined, 'Arrived at customs clearance warehouse', 'customs'],
      ['2026-03-06T23:28:48+08:00', undefined, undefined, undefined, undefined, 'Arrived at Destinated Airport', 'in_transit'],
      ['2026-03-05T23:12:32+08:00', undefined, undefined, undefined, undefined, 'The flight has taken off', 'in_transit'],
      ['2026-03-04T18:30:57+08:00', undefined, undefined, undefined, undefined, 'Estimated arrival date is March 6th', 'in_transit'],
      ['2026-03-04T18:30:47+08:00', undefined, undefined, undefined, undefined, 'Estimated departure is March 5th', 'in_transit'],
      ['2026-03-03T04:54:17+08:00', undefined, undefined, undefined, 'CN', 'Cargo handed over to the airline', 'in_transit'],
      ['2026-03-03T03:54:53+08:00', undefined, undefined, undefined, 'CN', 'Domestic customs clearance completed', 'in_transit'],
      ['2026-03-03T03:54:17+08:00', undefined, undefined, undefined, 'CN', 'Package has been packed and delivered to airport', 'in_transit'],
      ['2026-03-02T12:15:00+01:00', '2026-03-02T12:15:00', 'Europe/Berlin', 'carrier', undefined,
        'The instruction data for this shipment have been provided by the sender to DHL electronically', 'registered'],
      ['2026-03-01T18:37:40+08:00', undefined, undefined, undefined, undefined, 'The electronic cargo information has been received', 'registered'],
    ]);
    // DHL's absent-recipient sentence in the same place is read on the destination's clock too, not Beijing's.
    const absentPayload = fixture('track-dhl-placeless') as { data: Record<string, unknown>[] }[];
    const absentRound = 'The recipient was not present. Please find more information&lt;a href=https://www.example.com/help/status.html#not-delivered&gt; here.&lt;/a&gt;';
    const record = absentPayload[0]!.data[0]!;
    record.trackContent = absentRound;
    (record.trackDetails as Record<string, unknown>[])[0]!.track_content = absentRound;
    expect(dateLocalClocks('jrt', parseJrtTrack(absentPayload, 'UP0000000000000004', readAt)!).events?.[0]).toMatchObject({
      time: '2026-03-12T16:35:00+01:00', time_zone: 'Europe/Rome', time_zone_basis: 'destination',
      description: 'The recipient was not present. Please find more information here.', stage: 'failed_attempt' });
    // The adapter dates them the same way, and a destination on another clock takes its own.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('track-dhl-placeless')));
    await expect(adapter(environment(fetcher)).track({ number: 'UP0000000000000004' })).resolves
      .toMatchObject({ last_update: '2026-03-12T16:35:00+01:00', events: expect.arrayContaining([result.events![0]]) });
    const payload = fixture('track-dhl-placeless') as { data: Record<string, unknown>[] }[];
    payload[0]!.data[0]!.consigneeCountry = 'GR';
    const greek = parseJrtTrack(payload, 'UP0000000000000004', readAt)!;
    expect(greek.events?.slice(0, 5).map(({ time, time_zone }) => [time, time_zone])).toEqual([
      ['2026-03-12T16:35:00+02:00', 'Europe/Athens'], ['2026-03-12T08:21:00+02:00', 'Europe/Athens'],
      ['2026-03-11T20:11:00+02:00', 'Europe/Athens'], ['2026-03-11T20:10:00+02:00', 'Europe/Athens'],
      ['2026-03-10T09:14:00+01:00', 'Europe/Berlin'],
    ]);
  });

  it('reads DHL’s rows with a town on that town’s clock, and those beside a country’s code as without a place', () => {
    const payload = fixture('track-dhl') as { data: { consigneeCountry: string, trackDetails: Record<string, string>[] }[] }[];
    const record = payload[0]!.data[0]!;
    const rows = record.trackDetails;
    const at = (content: string) => rows.find(({ track_content }) => track_content === content)!;
    record.consigneeCountry = 'PL';
    at('the shipment has been processed in the parcel center of origin').track_location = 'hagen';
    at('loaded to movement / tour vehicle').track_location = 'poznan';
    at('unloaded from movement / tour vehicle').track_location = 'pl';
    const handover = at('the instruction data for this shipment have been provided by the sender to dhl electronically');
    rows.splice(rows.indexOf(handover), 0, { ...handover, track_content: 'shipment in transit to dhl', track_date: '2026-03-05 07:11:55', track_createdate: '2026-03-05 07:11:55', track_location: 'de' });
    const result = parseJrtTrack(payload, UP_REFERENCE, Date.parse('2026-03-15T00:00:00Z'))!;
    const dated = (content: string) => result.events?.filter(({ description }) => description === content)
      .map(({ time, time_zone, time_zone_basis }) => [time, time_zone, time_zone_basis]);
    // A parcel centre's scan in Germany, on Germany's clock, not on the platform's.
    expect(dated('the shipment has been processed in the parcel center of origin')).toEqual([['2026-03-12T16:05:27+01:00', 'Europe/Berlin', 'place']]);
    expect(dated('loaded to movement / tour vehicle')).toEqual([['2026-03-14T16:11:00+01:00', 'Europe/Warsaw', 'place']]);
    expect(dated('unloaded from movement / tour vehicle')).toEqual([['2026-03-14T16:10:00+01:00', 'Europe/Warsaw', 'destination']]);
    // The country's code is shown as other places name a country.
    expect(result.events?.find(({ description }) => description === 'unloaded from movement / tour vehicle')?.location).toBe('PL');
    expect(result.events?.find(({ description }) => description === 'loaded to movement / tour vehicle')?.location).toBe('poznan');
    // The label's data, beside the destination's code, comes from Germany.
    expect(dated('the instruction data for this shipment have been provided by the sender to dhl electronically'))
      .toEqual([['2026-03-04T10:01:11+01:00', 'Europe/Berlin', 'carrier']]);
    // So does DHL's transport to DHL, its sentence shortened, which DHL Germany dates on its clock.
    expect(dated('shipment in transit to dhl')).toEqual([['2026-03-05T07:11:55+01:00', 'Europe/Berlin', 'carrier']]);
    expect(result.events?.find(({ description }) => description === 'shipment in transit to dhl')?.location).toBe('DE');
    // JRT's own rows at a town stay on the platform's clock.
    expect(dated('Goods leave the operation center')).toEqual([['2026-03-04T09:40:08+08:00', undefined, undefined]]);
  });

  it('reads DHL’s return as returned, the delivery back to the sender included', () => {
    const payload = fixture('track-dhl') as { data: { trackDetails: Record<string, string>[] }[] }[];
    const rows = payload[0]!.data[0]!.trackDetails;
    const row = (date: string, content: string) => ({ ...rows[0]!, track_content: content, track_createdate: date, track_date: date });
    rows.unshift(
      row('2026-03-14 18:00:00', 'returned shipment has been received by processing center'),
      row('2026-03-14 17:30:00', 'the shipment has been successfully delivered'),
      row('2026-03-14 17:00:00', 'loaded to movement / tour vehicle(return to sender)'),
      row('2026-03-14 16:50:00', 'the shipment has been processed in the destination parcel center'),
      row('2026-03-14 16:40:00', 'shipment will be returned to origin-not ordered'),
      row('2026-03-14 16:30:00', 'held for consignee collection'),
      row('2026-03-14 16:20:00', 'not delivered-consignee could not be reached'),
    );
    const result = parseJrtTrack(payload, UP_REFERENCE, Date.parse('2026-03-15T00:00:00Z'))!;
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', current_stage_source: 'carrier_map' });
    expect(result.events?.slice(0, 8).map(({ stage }) => stage)).toEqual(['returned', 'returned', 'returned', 'returned',
      'returned', 'ready_for_pickup', 'failed_attempt', 'in_transit']);
    // A return the shared wording rules read alone starts no return leg.
    rows.splice(0, 7, row('2026-03-14 17:30:00', 'the shipment has been successfully delivered'),
      row('2026-03-14 16:40:00', 'shipment returned to sender'));
    const worded = parseJrtTrack(payload, UP_REFERENCE, Date.parse('2026-03-15T00:00:00Z'))!;
    expect(worded.events?.slice(0, 2).map(({ stage, stage_source }) => [stage, stage_source]))
      .toEqual([['delivered', 'carrier_map'], ['returned', 'wording:language']]);
  });

  it('offers a UP reference to recognition, which asks the tracker', async () => {
    expect(detectCarrierMatch(UP_REFERENCE)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['jrt'] });
    expect(recognitionCandidates(UP_REFERENCE).map(({ carrier }) => carrier)).toEqual(['jrt']);
    expect(detectCarrierMatch('UP000000000000002').candidates).not.toContain('jrt');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('track-dhl')))
      .mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).recognize!(UP_REFERENCE)).resolves.toMatchObject({ known: true });
    await expect(adapter(environment(fetcher)).recognize!('NOTFOUND000003')).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('maps every wording it lists as a whole phrase, whatever day the airport row books', () => {
    for (const entry of statuses.entries) {
      for (const wording of 'english' in entry && entry.english ? [entry.wording, entry.english] : [entry.wording]) {
        expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(entry.stage);
      }
    }
    const answer = (description: string) => statusMapAnswer({ carrier: 'jrt', providerCode: null, description });
    expect(answer('货物已交机场,预计18号的航班 Goods delivered to airport, scheduled on flight of the 18th')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('Flight is expected to take off on September 11')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('Flight is expected to take off on November?3')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('The flight is expected to depart on 10.27 and land on 10.28')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('The flight has departed and is expected to 1.3 land')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // A delayed connecting flight names its landing day the same way.
    expect(answer('Sorry, the second flight has been delayed and is expected to 11.12 land')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('报关已放行等待3号航班起飞 Customs released,Awaiting departure on flight of the 3rd')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('10/22号航班')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // A delayed flight names its new day in both halves.
    expect(answer('航班延误，预计12/3号飞出 Flight delayed, estimated departure on Dec 3.')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('航班延误，预计11/21号飞出 Flight delayed, estimated departure on November 21st')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('航班延误，预计10/24号飞出 Flight delayed, estimated departure on Oct.24.')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // The airport row that waits for the booked flight names its day in both halves.
    expect(answer('货物已交机场,等待23号的航班起飞 Goods have been delivered to the airport, pending departure on the flight on the 23rd.'))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    // DHL's sorting scan, as JRT copies it, is one of DHL's rows, on DHL's clock.
    expect(answer('sorted')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(isJrtDhlRow('sorted')).toBe(true);
    expect(isJrtDhlRow('sorted at the airport')).toBe(false);
    // DHL's row on the way to it, in DHL's own case, is DHL's too.
    expect(answer('The shipment is in transit to DHL')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(isJrtDhlRow('The shipment is in transit to DHL')).toBe(true);
    // DHL's round that found no such address, and the return it starts, on DHL's clock.
    expect(answer('not delivered-bad address')).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(answer('shipment will be returned to origin-bad address')).toEqual({ kind: 'mapped', stage: 'returned' });
    expect(isJrtDhlRow('not delivered-bad address')).toBe(true);
    // The recipient's preferred location is DHL's note at the destination, on its clock there: it moves nothing.
    const preferred = 'A preferred location was designated as a reception option for this shipment.';
    expect(answer(preferred)).toEqual({ kind: 'mapped', stage: 'pending' });
    expect(isJrtDhlRow(preferred)).toBe(true);
    expect(isJrtDhlGermanRow(preferred)).toBe(false);
    // DHL's round that found no one, copied to the minute without a place, is DHL's too: the same sentence comes with
    // the destination's country on its clock there, beside DHL's other rows.
    const absent = 'The recipient was not present. Please find more information here.';
    expect(answer(absent)).toEqual({ kind: 'mapped', stage: 'failed_attempt' });
    expect(isJrtDhlRow(absent)).toBe(true);
    expect(isJrtDhlRow('The recipient could not be found at the address on the shipment.')).toBe(true);
    expect(isJrtDhlGermanRow(absent)).toBe(false);
    // A hand-over to the delivering carrier, not a delivery.
    expect(answer('已交服务商 Delivered to service provider')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // DHL's row for the parcel on its way to it, as JRT copies it in lower case.
    expect(answer('shipment in transit to dhl')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // The bilingual row of a booked flight reads alike whatever its day.
    expect(answer('预计10.29航班/Flight scheduled for October 29th')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('预计11.3航班/Flight scheduled for November 3rd')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('预计配载航班11月11日,Expected flight on November 11th')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('预计配载航班12月2日，Expected flight on December 2nd')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // On the line into Latin America the booked flight and the flight name the destination and the day.
    expect(answer('Se espera que el vuelo salga hacia Perú el 12 de diciembre')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('The flight is en route to the airport in Colombia')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // Landed, the parcel is still the flight's, until the next row says customs has it.
    expect(answer('The flight has landed, and the package is ready to be handed over to customs for clearance.')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('and the package has been handed over to customs for clearance')).toEqual({ kind: 'mapped', stage: 'customs' });
    // DHL's arrival in the destination country, its import parcel centre's departure and its round, as DHL's own map reads them.
    expect(answer('The shipment has arrived in the destination country/destination area.')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('The shipment has left the import parcel center in the destination country/destination area.')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(answer('The shipment has been loaded onto the delivery vehicle')).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    // The destination's completed clearance lets the parcel go on.
    expect(answer('Customs clearance in destination country completed')).toEqual({ kind: 'mapped', stage: 'in_transit' });
    // J&T Express Mexico's rows read alike whatever their towns, sites, courier and phone; its collection after the
    // clearance is no first acceptance, with its "¡" or the "?" the platform's GBK leaves of it.
    for (const description of ['【Villa Uno】Tu envío ha salido de【SITE.pdv】con destino a【MEXICO.sc】', '【Villa Uno】Tu envío ha llegado a【MEXICO.sc】',
      '【Villa Dos】【CLC-Norte.pdv】?Recolección exitosa!. El mensajero de J&T asignado CLC-NORTE1 recolectó tu envío. Si requieres mayor información, contáctanos al: 5500000000',
      '【Villa Dos】【CLC-Norte.pdv】¡Recolección exitosa!. El mensajero de J&T asignado OTRO.pcp recolectó tu envío.']) {
      expect(answer(description), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
      expect(isJrtJtMexicoRow(description), description).toBe(true);
    }
    expect(isJrtJtMexicoRow('Tu envío ha llegado')).toBe(false);
    // Its courier on the way to the recipient's home reads alike whatever the town, the site, the courier and the phone.
    for (const description of [
      '【Villa Uno】【SITE-Sur.pdv】El mensajero de J&T Express OTRO1-DPA.pcp está en camino a tu domicilio. Si requieres mayor información, contáctanos al 5500000000',
      '【Villa Dos】【CLC-Norte.pdv】El mensajero de J&T Express CLC-NORTE1 está en camino a tu domicilio.']) {
      expect(answer(description), description).toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
      expect(isJrtJtMexicoRow(description), description).toBe(true);
    }
    // So is the hand-over to FedEx after the clearance, and the warehouse's receipt before it: neither is an acceptance.
    for (const description of ['It has been handed over to the service provider.',
      'The cargo has been picked up and arrived at the warehouse，awaiting outbound shipment', 'Arrived at FedEx hub', 'Departed FedEx hub', 'On the way']) {
      expect(answer(description), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    for (const description of [
      '已交服务商',
      '货物已交机场,预计18号的航班',
      '货物已交机场,预计18号的航班 Goods delivered to airport, scheduled on flight of the 18th CA000',
      '货物已交机场,预计号的航班 Goods delivered to airport, scheduled on flight of the th',
      'loaded to movement / tour vehicle again',
      'The flight is expected to depart on soon and land on 10.27',
      '10/22号航班 CA000',
      'Se espera que el vuelo salga hacia México',
    ]) expect(answer(description), description).toEqual({ kind: 'unknown' });
  });

  it('maps the platform’s own row in Chinese and in the English shown for it, and links no plain-HTTP page', () => {
    for (const description of ['货物电子信息已经收到', 'The electronic cargo information has been received']) {
      expect(statusMapAnswer({ carrier: 'jrt', providerCode: null, description })).toEqual({ kind: 'mapped', stage: 'registered' });
    }
    expect(adapter(environment(vi.fn<typeof fetch>()))).toMatchObject({ id: 'jrt', recordsSteps: true, steps: ['direct', 'retry'] });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.portal).not.toHaveProperty('searchUrl');
  });
});

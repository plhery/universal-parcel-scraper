import { describe, expect, it } from 'vitest';
import { classifyEvent, event, localEvent, result } from './result.js';
import { statusMap } from '../status.js';
import { hasPrivateDeliveryDetails } from '../../core/status/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';

describe('shared provider result', () => {
  it('keeps customs refusing a parcel an exception, not customs at work', () => {
    for (const wording of ['Customs clearance: Refusal to release', 'Return: Refusal by customs', 'Failed to clear at import customs',
      'Customs clearance: Return allowed']) expect(classifyEvent(wording), wording).toEqual({ stage: 'exception', stage_source: 'wording:provider' });
    expect(classifyEvent('Handed over to the customs').stage).toBe('customs');
  });

  it('reads an import clearance stopped by an invalid tariff code as a problem, as ParcelsApp relays it', () => {
    for (const wording of ['Invalid HSCode', 'Invalid HS code.']) expect(classifyEvent(wording), wording).toEqual({ stage: 'exception', stage_source: 'wording:provider' });
    expect(classifyEvent('Invalid HSCode corrected').stage_source).toBe('none');
  });

  it("reads China Post's departure from the office of posting relayed uncoded in Chinese in transit", () => {
    // Track123's copy, with the office in brackets, of the row 17TRACK gives in English as "Departed from the office of posting".
    expect(classifyEvent('离开收寄点【示例】')).toEqual({ stage: 'in_transit', stage_source: 'wording:provider' });
  });

  it("reads the destination post's scans relayed in China Post's Chinese as China Post's map reads them", () => {
    for (const wording of ['到达寄达地处理中心', '离开【示例】处理中心', '寄达地海关允许进口（无需缴税）']) {
      expect(classifyEvent(wording), wording).toEqual({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
  });

  it("reads the posts' IPS event names after the office's country as PHLPost's map reads them", () => {
    expect(classifyEvent('China Posting of item')).toEqual({ stage: 'accepted', stage_source: 'wording:provider' });
    for (const wording of ['China Receive item at origin country gateway', 'China Dispatch item to destination country',
      'China Dispatch to country of destination', 'Philippines Receive at country of destination', 'Philippines Enroute to delivery office',
      'Hong Kong Dispatch item to destination country']) {
      expect(classifyEvent(wording), wording).toEqual({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    // Only a country's name: a code or another word before the event names no office's country.
    for (const wording of ['CN Posting of item', 'Sample Posting of item']) expect(classifyEvent(wording).stage_source, wording).toBe('none');
  });

  it("reads a first-mile warehouse's order and check-in before iMile's acceptance, as ParcelsApp relays them", () => {
    expect(classifyEvent('Order is created, XX is waiting for check-in at the warehouse')).toEqual({ stage: 'registered', stage_source: 'wording:provider' });
    expect(classifyEvent('Package checked in at warehouse')).toEqual({ stage: 'accepted', stage_source: 'wording:provider' });
  });

  it("reads an airline's load device broken down at the destination airport in transit, the parcels awaiting the forwarder", () => {
    for (const wording of ['ULD breakdown completed, awaiting pick\u2011up in Sampletown', 'ULD breakdown completed, awaiting pick-up in Sampletown']) {
      expect(classifyEvent(wording), wording).toEqual({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
  });

  it('reads the destination post taking the item over as a hand-over on the way, not the acceptance', () => {
    // Australia Post's INT-2185, as Ship24 relays it without its code, days after the item left Australia.
    expect(classifyEvent('Item handed over to the local postal authority')).toEqual({ stage: 'in_transit', stage_source: 'wording:provider' });
    expect(classifyEvent('Handed over to local carrier').stage).toBe('in_transit');
    // The sender's hand-over is still the acceptance.
    expect(classifyEvent('Item handed over').stage).toBe('accepted');
  });

  it("reads DHL's \"Available for pickup shortly\" relayed by a provider as on its way to the outlet, as DHL does", () => {
    expect(classifyEvent('Available for pickup shortly').stage).toBe('in_transit');
    expect(classifyEvent('Will be available for collection tomorrow').stage).toBe('in_transit');
    expect(statusMap.stage(null, 'available for pickup shortly')).toBe('in_transit');
    // Its German, and the outlet announced for the next business day after a failed round: not there yet either.
    expect(classifyEvent('In Kürze in Filiale abholbereit').stage).toBe('in_transit');
    expect(classifyEvent('Ready for pickup next business day').stage).toBe('in_transit');
    expect(statusMap.stage(null, 'in kürze in filiale abholbereit')).toBe('in_transit');
    expect(statusMap.stage(null, 'ready for pickup next business day')).toBe('in_transit');
    expect(classifyEvent('Sendung liegt in der Filiale zur Abholung bereit').stage).toBe('ready_for_pickup');
    expect(classifyEvent('The shipment is available for pickup').stage).toBe('ready_for_pickup');
    expect(classifyEvent('The shipment is ready for collection').stage).toBe('ready_for_pickup');
  });

  it('names an unreadable timestamp\'s shape, never its digits', () => {
    expect(() => event('2026-11-12T24:61:00Z', 'Arrived at sorting center'))
      .toThrow('Tracking event has an invalid timestamp (9999-99-99T99:99:99Z)');
    expect(() => event('2026-11-12 01:00 CET', 'Arrived at sorting center')).toThrow('no valid timezone (9999-99-99 99:99 aaT)');
    expect(() => localEvent('12.11.2026', 'Arrived at sorting center')).toThrow('invalid timestamp (99.99.9999)');
    expect(() => localEvent(undefined, 'Arrived at sorting center')).toThrow('invalid timestamp (undefined)');
  });

  it('drops an entry in wording no rule reads when it is dated at the lookup', () => {
    const now = Date.now();
    const at = (ago: number) => new Date(now - ago).toISOString();
    const scan = event(at(86_400_000), 'Arrived at sorting center')!;
    const notice = event(at(1_000), 'Example notice nobody has worded before')!;
    expect(notice.stage_source).toBe('none');
    expect(result([notice, scan], 'ParcelsApp').events?.map(({ description }) => description)).toEqual(['Arrived at sorting center']);
    // A provider's clock can run ahead of ours.
    expect(result([event(new Date(now + 60_000).toISOString(), notice.description)!, scan], 'ParcelsApp').events).toHaveLength(1);
    // Read wording that new is a scan, and unread wording an hour old is a scan in words no rule knows yet.
    expect(result([event(at(1_000), 'Delivered')!, scan], 'ParcelsApp').events).toHaveLength(2);
    expect(result([event(at(3_600_000), notice.description)!, scan], 'ParcelsApp').events).toHaveLength(2);
    // A notice alone says nothing about the parcel.
    expect(() => result([notice], 'ParcelsApp')).toThrow('No usable tracking events');
  });

  it('sets aside a timeline written to a schedule, rows a fixed time apart to the second', () => {
    const day = Date.parse('2026-03-02T10:03:26Z');
    const clock = (ms: number) => new Date(ms).toISOString();
    const scan = event('2026-03-01T08:12:47Z', 'Shenzhen Processing Center has received it')!;
    // 47 hours 21 minutes apart, the seconds stepping by one now and then.
    const steps = [0, 170_460, 340_921, 511_382, 681_842].map((offset) => event(clock(day + offset * 1_000), 'In transit')!);
    const relayed = result([scan, ...steps], '17TRACK');
    expect(relayed.events!.map(({ time }) => time)).toEqual(['2026-03-01T08:12:47.000Z']);
    expect(relayed).toMatchObject({ current_stage: 'accepted', last_status_text: 'Shenzhen Processing Center has received it' });
    expect(() => result(steps, '17TRACK')).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'written_ahead' }));
    // Three such rows, rows whose spacing drifts, and rows dated on whole minutes stay.
    expect(result([scan, ...steps.slice(0, 3)], '17TRACK').events).toHaveLength(4);
    const drifting = [0, 170_460, 340_925, 511_390].map((offset) => event(clock(day + offset * 1_000), 'In transit')!);
    expect(result([scan, ...drifting], '17TRACK').events).toHaveLength(5);
    const daily = [1, 2, 3, 4, 5].map((date) => event(`2026-03-0${date}T09:00:00Z`, 'In transit')!);
    expect(result(daily, '17TRACK').events).toHaveLength(5);
  });

  it("reads an acceptance repeated in an older row's words after the parcel moved as transit", () => {
    const sorted = 'The shipment has been processed in the parcel center of origin';
    const relayed = result([
      event('2030-01-05T17:50:00Z', sorted, 'accepted')!,
      event('2030-01-05T08:01:00Z', 'The shipment was misrouted.', 'exception')!,
      event('2030-01-03T22:58:00Z', sorted, 'in_transit')!,
      event('2030-01-02T16:41:00Z', sorted, 'accepted')!,
    ], '17TRACK');
    expect(relayed.events?.map(({ stage }) => stage)).toEqual(['in_transit', 'exception', 'in_transit', 'accepted']);
    // Before anything moved the parcel, or once it came back, the words accept it again.
    const again = result([
      event('2030-02-05T10:00:00Z', 'Accepted at the post office', 'accepted')!,
      event('2030-02-04T10:00:00Z', 'Returned to the sender', 'returned')!,
      event('2030-02-02T10:00:00Z', 'Departed the sorting center', 'in_transit')!,
      event('2030-01-02T12:00:00Z', 'Accepted at the post office', 'accepted')!,
      event('2030-01-02T10:00:00Z', 'Accepted at the post office', 'accepted')!,
    ], '17TRACK');
    expect(again.events?.map(({ stage }) => stage)).toEqual(['accepted', 'returned', 'in_transit', 'accepted', 'accepted']);
  });

  it('drops a generic "On the way" beside a specific scan at its instant and place, as FedEx writes it', () => {
    const at = (time: string, description: string, location: string) => ({ ...event(time, description)!, location });
    const relayed = result([
      at('2026-10-28T19:13:00Z', 'On the way', 'EXAMPLE CITY FR'),
      at('2026-10-28T19:13:00Z', 'Departed FedEx hub', 'EXAMPLE CITY FR'),
      at('2026-10-28T19:13:00Z', 'On the way', 'OTHER CITY FR'),
      at('2026-10-28T08:00:00Z', 'On the way', 'EXAMPLE CITY FR'),
    ], 'ParcelsApp');
    expect(relayed.events?.map(({ description, location }) => [description, location])).toEqual([
      ['On the way', 'OTHER CITY FR'],
      ['Departed FedEx hub', 'EXAMPLE CITY FR'],
      ['On the way', 'EXAMPLE CITY FR'],
    ]);
  });

  it('drops a location that only repeats the wording, as 17TRACK relays a customs step', () => {
    const at = (time: string, description: string, location: string) => ({ ...event(time, description)!, location });
    const relayed = result([
      at('2030-01-02T22:48:13Z', 'Customs clearance in progress', 'Customs clearance in progress'),
      at('2030-01-02T10:00:00Z', 'Arrived at sorting center.', 'arrived at  sorting center'),
      at('2030-01-01T10:00:00Z', 'Customs clearance in progress', 'Example City'),
    ], '17TRACK');
    expect(relayed.events?.map(({ description, location }) => [description, location])).toEqual([
      ['Customs clearance in progress', undefined],
      ['Arrived at sorting center.', undefined],
      ['Customs clearance in progress', 'Example City'],
    ]);
    expect(relayed.events?.[0]).not.toHaveProperty('location');
  });

  it("keeps no time for the seller's step or GLS's progress sentence when dated after the lookup", () => {
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    const ahead = result([event(at(22 * 3_600_000), 'Pending shipping by the seller')!], 'ParcelsApp');
    expect(ahead).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null });
    expect(ahead.events).toHaveLength(1);
    expect(ahead.events?.[0]).not.toHaveProperty('time');
    // Dated before the lookup, it is the moment of the step.
    expect(result([event(at(-3_600_000), 'Pending shipping by the seller')!], 'ParcelsApp').events?.[0]?.time).toBe(at(-3_600_000));
    // So does GLS's progress bar sentence, dated by GLS's delivery estimate.
    const summary = 'The parcel is on its way to the final parcel center. For more information, please see the detailed shipment tracking below.';
    expect(result([event(at(60 * 3_600_000), summary, 'in_transit')!], 'ParcelsApp').events?.[0]).not.toHaveProperty('time');
    expect(result([event(at(-3_600_000), summary, 'in_transit')!], 'ParcelsApp').events?.[0]?.time).toBe(at(-3_600_000));
    // Another scan dated ahead keeps its time, for the parcel app to flag.
    expect(result([event(at(22 * 3_600_000), 'Arrived at sorting center')!], 'ParcelsApp').events?.[0]?.time).toBe(at(22 * 3_600_000));
  });

  it("reads GLS's ParcelShop scan by the carrier scans around it", () => {
    const shop = 'The parcel has reached the ParcelShop';
    const stageOf = (events: (ReturnType<typeof event>)[]) => result(events.map((entry) => entry!), 'Postal Ninja').events
      ?.find(({ description }) => description === shop)?.stage;
    // The sender's drop-off, before GLS has the parcel.
    expect(stageOf([event('2026-03-02T16:01:10Z', shop), event('2026-03-04T16:43:41Z', 'The parcel was handed over to GLS'),
      event('2026-03-05T11:30:00Z', 'Delivered')])).toBe('accepted');
    // The parcel waiting for collection, after GLS carried it.
    expect(stageOf([event('2026-03-02T16:43:41Z', 'The parcel was handed over to GLS'),
      event('2026-03-03T09:00:00Z', 'The parcel has left the parcel center'), event('2026-03-04T10:00:00Z', shop)])).toBe('ready_for_pickup');
    // Alone, or after the label alone, the wording does not say which.
    expect(stageOf([event('2026-03-02T16:01:10Z', shop)])).toBe('pending');
    expect(stageOf([event('2026-03-01T08:00:00Z', 'Shipment information received', 'registered'), event('2026-03-02T16:01:10Z', shop)])).toBe('pending');
  });

  it('puts a step dated by its day alone above the newest scan of its day at an earlier stage', () => {
    const scan = (clock: string, description: string, stage: string) => ({
      ...(clock.length === 10 ? { local_time: clock } : { time: clock }), description, stage, stage_source: 'carrier_map',
    });
    const order = (events: ReturnType<typeof scan>[], preserveOrder = false) => result(events, 'ParcelsApp', preserveOrder)
      .events?.map(({ description }) => description);
    const history = [
      scan('2026-01-06T09:00:00-05:00', 'Departed sorting center', 'in_transit'),
      scan('2026-01-05', 'Picked up', 'accepted'),
      scan('2026-01-05T20:41:00-05:00', 'Arrived at sorting center', 'in_transit'),
      scan('2026-01-05T09:17:00-05:00', 'Shipment information sent', 'registered'),
      scan('2026-01-04T10:00:00-05:00', 'Order created', 'pending'),
    ];
    expect(order(history)).toEqual(['Departed sorting center', 'Arrived at sorting center', 'Picked up', 'Shipment information sent', 'Order created']);
    // With no scan of its day at an earlier stage, or no stage, it stays below the day's timed scans.
    expect(order([history[1]!, history[2]!, { ...history[3]!, stage: 'accepted' }])).toEqual([
      'Arrived at sorting center', 'Shipment information sent', 'Picked up',
    ]);
    expect(order([{ ...history[1]!, stage: 'exception' }, history[3]!])).toEqual(['Shipment information sent', 'Picked up']);
    // A provider whose order stands keeps it.
    expect(order([history[3]!, history[1]!], true)).toEqual(['Shipment information sent', 'Picked up']);
  });

  it('keeps scans of one instant in the order the provider listed them, oldest or newest first', () => {
    const scan = (time: string, description: string) => ({ time, description, stage: 'in_transit', stage_source: 'carrier_map' });
    const oldestFirst = [
      scan('2026-01-05T09:00:00Z', 'Accepted at sorting center'), scan('2026-01-05T20:41:00Z', 'Arrived at sorting center'),
      scan('2026-01-05T20:41:00Z', 'Departed sorting center'), scan('2026-01-06T09:00:00Z', 'Arrived at delivery depot'),
    ];
    const newest = ['Arrived at delivery depot', 'Departed sorting center', 'Arrived at sorting center', 'Accepted at sorting center'];
    expect(result(oldestFirst, 'ParcelsApp').events?.map(({ description }) => description)).toEqual(newest);
    expect(result([...oldestFirst].reverse(), 'ParcelsApp').events?.map(({ description }) => description)).toEqual(newest);
  });

  it('keeps rows of one instant and wording apart when their stages or codes disagree, in either order', () => {
    const scan = (stage: string, code: string, location?: string) => ({
      time: '2026-01-05T20:41:00Z', description: 'Processed', stage, stage_source: 'carrier_map', provider_code: code,
      ...(location ? { location } : {}),
    });
    const rows = [scan('customs', 'C1', 'EXAMPLE HUB'), scan('accepted', 'A1', 'OTHER HUB')];
    const read = (events: Parameters<typeof result>[0]) => result(events, 'Ship24').events?.map(({ stage, provider_code, location }) => [stage, provider_code, location]);
    for (const events of [rows, [...rows].reverse()]) {
      expect(read(events)).toHaveLength(2);
      expect(read(events)).toEqual(expect.arrayContaining([['customs', 'C1', 'EXAMPLE HUB'], ['accepted', 'A1', 'OTHER HUB']]));
    }
    // A code on one copy only does not part it from the copy without one.
    const coded = [scan('customs', 'C1', 'EXAMPLE HUB'), { ...scan('customs', 'C1'), provider_code: undefined }];
    for (const events of [coded, [...coded].reverse()]) expect(read(events)).toEqual([['customs', 'C1', 'EXAMPLE HUB']]);
  });

  it('keeps two steps of one day at other places apart, in either order', () => {
    const step = (location: string) => ({ local_time: '2026-01-05', description: 'In transit', stage: 'in_transit', stage_source: 'wording:provider', location });
    const rows = [step('Example City, FR'), step('Other Town, FR')];
    for (const events of [rows, [...rows].reverse()]) {
      expect(result(events, 'ParcelsApp').events?.map(({ location }) => location).sort()).toEqual(['Example City, FR', 'Other Town, FR']);
    }
  });

  it('reads a copy without a place, or with its place spelt otherwise or in part, as one scan with it, in either order', () => {
    const step = (location?: string) => ({
      local_time: '2026-01-05', description: 'In transit', stage: 'in_transit', stage_source: 'wording:provider', ...(location ? { location } : {}),
    });
    const placed = [step('Example City, FR'), step()];
    const forward = result(placed, 'ParcelsApp').events;
    expect(forward).toEqual([step('Example City, FR')]);
    expect(result([...placed].reverse(), 'ParcelsApp').events).toEqual(forward);
    for (const other of ['EXAMPLE  CITY FR.', 'Example City']) {
      const rows = [step('Example City, FR'), step(other)];
      for (const events of [rows, [...rows].reverse()]) expect(result(events, 'ParcelsApp').events).toHaveLength(1);
    }
    // A timed copy without a place keeps the place of the other copy, whichever came first.
    const timed = [{ ...event('2026-01-05T09:00:00Z', 'Arrived at sorting center')!, location: 'Example City' }, event('2026-01-05T09:00:00Z', 'Arrived at sorting center')!];
    expect(result(timed, 'ParcelsApp').events).toEqual(result([...timed].reverse(), 'ParcelsApp').events);
    expect(result(timed, 'ParcelsApp').events?.map(({ location }) => location)).toEqual(['Example City']);
  });

  it("reads a copy of SunYou's departure without the last-mile number, as SunYou's own result does", () => {
    expect(event('2026-01-07T12:45:00+08:00', 'Departed Sunyou Facility, Carrier Tracking Number:  ZZ000000005GB'))
      .toMatchObject({ description: 'Departed Sunyou Facility' });
  });

  it("reads Česká pošta's alerts to the addressee as messages, not the event they name", () => {
    for (const alert of ['E-mail alert for the addressee - the consignment was sent for transportation.',
      'Email alert for the addressee - consignment delivery date.', 'SMS alert for the addressee - the consignment was deposited.']) {
      expect(event('2026-01-07T12:45:00+01:00', alert), alert).toMatchObject({ description: alert, stage: 'pending', stage_source: 'none' });
    }
    expect(event('2026-01-07T12:45:00+01:00', 'The consignment was sent for transportation.')?.stage_source).not.toBe('none');
    // Its record of the courier's position at an attempt is no step either; the attempt's outcome has its own row.
    expect(event('2026-01-07T12:45:00+01:00', 'Geographical data from the delivery attempt.')).toMatchObject({ stage: 'pending', stage_source: 'none' });
    // The office of exchange takes the item in after its posting: in transit, not a second acceptance.
    expect(event('2026-01-07T12:45:00+01:00', 'The consignment was accepted by post office of exchange.')).toMatchObject({ stage: 'in_transit' });
  });

  it("reads DPD Poland's notices to the recipient as messages, whatever code they are filed under", () => {
    for (const notice of ['Mail notification', 'SMS notification', 'Sent notification', 'Powiadomienie SMS', 'Wysłano powiadomienie']) {
      expect(event('2026-01-07T12:45:00+01:00', notice, 'InTransit'), notice).toMatchObject({ stage: 'pending', stage_source: 'none' });
    }
    expect(event('2026-01-07T12:45:00+01:00', 'Parcel received by DPD depot', 'InTransit')?.stage_source).not.toBe('none');
  });

  it("reads China Post's notice that the delivery time may stretch as a message", () => {
    for (const notice of ['受台风天气影响，邮件时限可能有所延长，我们正全力协调资源加快处理，请您耐心等待', '受降雪影响,邮件投递时限可能延长']) {
      expect(event('2026-01-07T12:45:00+08:00', notice, 'InTransit'), notice).toMatchObject({ stage: 'pending', stage_source: 'none' });
    }
  });

  it("reads Chronopost's notice to the recipient without the message type and medium appended to it", () => {
    const notice = 'Destinataire informé par SMS ou mail';
    for (const relayed of [`${notice}. Type du message : Retard Média utilisé : E-mail`, `${notice} Type du message : Echec de livraison`]) {
      expect(event('2026-01-07T12:45:00+01:00', relayed)).toMatchObject({ description: notice, stage: 'pending', stage_source: 'none' });
    }
    expect(event('2026-01-07T12:45:00+01:00', `${notice}. Rendez-vous`)?.description).toBe(`${notice}. Rendez-vous`);
  });

  it("leaves out DHL's detail line saying no further details are required, but not the scan beside it", () => {
    expect(event('2026-01-07T12:45:00Z', 'Keine weiteren Details erforderlich')).toBeNull();
    expect(localEvent('2026-01-07T12:45:00', 'Keine weiteren Details erforderlich.')).toBeNull();
    expect(event('2026-01-07T12:44:00Z', 'Entladung')).toMatchObject({ description: 'Entladung', stage: 'in_transit' });
    expect(event('2026-01-07T12:45:00Z', 'Keine weiteren Details erforderlich, Entladung')).not.toBeNull();
  });

  it("leaves out DPD Portugal's note of an expected delivery day it set, as its own adapter does", () => {
    expect(event('2026-01-07T18:16:00Z', 'DATA PREVISTA DE ENTREGA')).toBeNull();
    expect(event('2026-01-07T18:16:00Z', 'Data prevista de entrega alterada pelo destinatário')).not.toBeNull();
  });

  it('leaves out the emails and texts XDP sends, with the name they name, as its own tracker does', () => {
    expect(event('2026-03-02T07:00:00Z', 'Manifested but not collected email sent to Sam')).toBeNull();
    expect(event('2026-03-02T07:00:00Z', 'NOT COLLECTED EMAIL, Manifested but not collected email sent to Sam')).toBeNull();
    expect(event('2026-03-04T13:42:00Z', 'Clean email notification sent to Alex Example')).toBeNull();
    expect(event('2026-03-04T07:10:00Z', 'Delivery Email alert sent')).toBeNull();
    expect(event('2026-03-03T20:58:00Z', 'Collect SMS alert sent')).toBeNull();
    expect(event('2026-03-03T20:58:00Z', 'At Collection Depot')).toMatchObject({ description: 'At Collection Depot' });
  });

  it("leaves out 17FEIA's estimated departure, written before the flight, so it cannot pass for the latest step", () => {
    expect(event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18')).toBeNull();
    expect(event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18, OTHER', 'InTransit')).toBeNull();
    expect(localEvent('2026-01-07T09:16:18', 'Estimated departure date: 2026-01-08 17:16:18')).toBeNull();
    const declaration = event('2026-01-07T08:20:00Z', 'Export declaration in progress.')!;
    expect(result([event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18'), declaration]
      .filter((scan) => scan !== null), 'ParcelsApp')).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Export declaration in progress.' });
  });

  it("leaves out a carrier's schedule, dated when it is due: a vessel's estimated departure and arrival, the cut-off, a flight's ETD or ETA", () => {
    for (const label of ['Estimated Vessel Departure', 'Estimated Vessel Departure (Last Updated)', 'Estimated Vessel Arrival',
      'Estimated Vessel Arrival (Last Updated)', 'CFS/CY Cut-Off Date', 'Customer Documentation Cut-off', 'Flight ETD Sep 23.', 'Flight ETA Sep 25.']) {
      expect(event('2026-12-10T11:00:00Z', label, 'InTransit')).toBeNull();
    }
    expect(event('2026-10-05T01:27:00Z', 'Actual Vessel Departure', 'InTransit')).toMatchObject({ stage: 'in_transit' });
    expect(event('2026-10-06T08:03:00Z', 'Customer Booking Received', 'InTransit')).not.toBeNull();
  });

  it('leaves out a bracketed time with no words, which names no scan', () => {
    expect(event('2026-01-07T10:52:13+08:00', '( 10：23)', 'InTransit')).toBeNull();
    expect(localEvent('2026-01-07T10:52:13', '(10:23)')).toBeNull();
    expect(localEvent('2026-01-07T17:04:29', '(01.08)')).toBeNull();
    expect(event('2026-01-07T10:52:13+08:00', 'Departed (10:23)', 'InTransit')).toMatchObject({ stage: 'in_transit' });
  });

  it('leaves out a language label with no words after it', () => {
    expect(event('2026-01-07T16:17:00+08:00', '(中文:)', 'InTransit')).toBeNull();
    expect(event('2026-01-07T16:17:00+08:00', '（English：）', 'InTransit')).toBeNull();
    expect(event('2026-01-07T16:17:00+08:00', '(中文:已出库)', 'InTransit')).not.toBeNull();
  });

  it('leaves out a label without a letter or a digit', () => {
    expect(event('2026-11-22T09:08:00+01:00', '@')).toBeNull();
    expect(localEvent('2026-11-22T09:08:00', ' - ')).toBeNull();
    expect(event('2026-11-22T09:08:00+01:00', '@ Paris')).not.toBeNull();
    expect(event('2026-11-22T09:08:00+01:00', '已出库')).not.toBeNull();
  });

  it("reads Sameday's Bulgarian steps before it has the parcel, as ParcelsApp relays them", () => {
    expect(event('2026-01-07T12:45:00+02:00', 'Скоро ще вземем пратката Ви от подателя.'))
      .toMatchObject({ stage: 'registered', stage_source: 'wording:provider' });
    expect(event('2026-01-21T12:45:00+02:00', 'Подателят не предаде пратката.'))
      .toMatchObject({ stage: 'exception', stage_source: 'wording:provider' });
  });

  it("reads Russian Post's hand-over to the addressee or the sender, as ParcelsApp relays it and Postal Ninja translates it", () => {
    for (const wording of ['Вручение адресату', 'Вручение адресату почтальоном', 'Вручено 22 октября', 'Handed over. Delivery to the addressee by the postman']) {
      expect(event('2026-01-07T12:45:00+03:00', wording)).toMatchObject({ stage: 'delivered', stage_source: 'wording:provider' });
    }
    for (const wording of ['Вручение отправителю', 'Handed over. Delivery to the sender']) {
      expect(event('2026-01-07T12:45:00+03:00', wording)).toMatchObject({ stage: 'returned', stage_source: 'wording:provider' });
    }
    // The label the sender made, before the post office has the parcel.
    expect(event('2026-01-07T12:45:00+03:00', 'Tracking number assigned')).toMatchObject({ stage: 'registered', stage_source: 'wording:provider' });
  });

  it("reads Israel Post's lines on mail from abroad, as ParcelsApp translates them", () => {
    const stages: ReadonlyArray<readonly [string, string]> = [
      ['Received information about a package intended to be sent', 'registered'],
      [', - The item has been received for shipping', 'accepted'],
      ['EXAMPLE 1 AB, - the item has been shipped', 'in_transit'],
    ];
    for (const [wording, stage] of stages) {
      expect(event('2026-11-05T00:00:00+02:00', wording)).toMatchObject({ stage, stage_source: 'wording:provider' });
    }
  });
  it("reads Russian Post's steps on mail from abroad, as 17TRACK and ParcelsApp relay them", () => {
    const stages: ReadonlyArray<readonly [string, string]> = [
      ['Prepared for shipping', 'registered'],
      ['Прием', 'accepted'],
      ['Приём', 'accepted'],
      ['Acceptance', 'accepted'],
      ['Обработка,Прибыло в место международного обмена', 'in_transit'],
      ['Покинуло место международного обмена', 'in_transit'],
      ['Shipped from China', 'in_transit'],
    ];
    for (const [wording, stage] of stages) {
      expect(event('2026-01-07T12:45:00+03:00', wording)).toMatchObject({ stage, stage_source: 'wording:provider' });
    }
    // The customs rows, which the shared language rules read: the shop's data, customs taking the parcel in,
    // clearing it with no outcome yet, and releasing it.
    const customs: ReadonlyArray<readonly [string, string]> = [
      ['Таможенное декларирование,Данные от торговой площадки получены', 'registered'],
      ['Прием на таможню', 'customs'],
      ['Таможенное оформление', 'customs'],
      ['Таможенное оформление, Выпущено таможней', 'in_transit'],
    ];
    for (const [wording, stage] of customs) {
      expect(event('2026-01-07T12:45:00+03:00', wording)).toMatchObject({ stage, stage_source: 'wording:language' });
    }
    // The delivery office is another step, which the shared rules read as Russian Post's map reads its 8.2.
    expect(event('2026-01-07T12:45:00+03:00', 'Обработка, Прибыло в место вручения'))
      .toMatchObject({ stage: 'ready_for_pickup', stage_source: 'wording:language' });
  });

  it("reads the US post's scan abroad, the country in capitals after it, by its wording", () => {
    expect(classifyEvent('Acceptance, RUSSIAN FEDERATION')).toEqual({ stage: 'accepted', stage_source: 'wording:provider' });
    expect(classifyEvent('Processed Through Facility, MOSKVA EXAMPLE, RUSSIAN FEDERATION').stage).toBe('in_transit');
    // A code after a town is a state, a country in other letters a place, and a town no country.
    for (const wording of ['Acceptance, CA', 'Acceptance, Russian Federation', 'Acceptance, EXAMPLE TOWN']) {
      expect(classifyEvent(wording), wording).toEqual({ stage: 'pending', stage_source: 'none' });
    }
  });

  it("reads Yanwen's scan after its pickup, as ParcelsApp relays it", () => {
    expect(event('2026-01-07T12:45:00+08:00', 'Processing information input'))
      .toMatchObject({ stage: 'accepted', stage_source: 'wording:provider' });
  });

  it("reads Yanwen's batch hand-over and the destination pickup, and China Post's relayed receipt, hold and security return", () => {
    for (const wording of ['Batch delivery to carrier', 'Pick up by local carrier at destination port']) {
      expect(event('2026-01-07T12:45:00+08:00', wording)).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    for (const [wording, stage] of [['中国邮政已收取邮件', 'accepted'], ['出口海关/留存待验', 'customs'], ['【广州市处理中心】退回', 'exception'],
      ['【广州市处理中心】退回，备注:安检退回', 'exception'], ['【广州市处理中心】已出口直封', 'in_transit']] as const) {
      expect(event('2026-01-07T12:45:00+08:00', wording), wording).toMatchObject({ stage, stage_source: 'wording:provider' });
    }
  });

  it("reads iMile's sentences with its centre in 【】 or its driver's notice, as providers relay them", () => {
    for (const [wording, stage] of [
      ['【Milan center】Your order has been received.', 'in_transit'],
      ['Your order has been shipped from 【Milan center】.', 'in_transit'],
      ['Your order has assigned delivery drvier.', 'in_transit'],
      ['Your order has assigned pickup driver.', 'registered'],
      ['【Milan center】Delivered, Receiver Type:【Self】.', 'delivered'],
    ] as const) {
      expect(event('2026-11-21T14:42:00+01:00', wording), wording).toMatchObject({ stage, stage_source: 'wording:provider' });
    }
    // A sentence iMile's map does not know, and another carrier's place in 【】, stay unread.
    expect(event('2026-11-21T14:42:00+01:00', '【Milan center】Something else.')).toMatchObject({ stage: 'pending', stage_source: 'none' });
    expect(event('2026-11-21T14:42:00+08:00', '【广州市】快件已在仓库')).toMatchObject({ stage_source: 'none' });
    // Its cancelled collection task names no step, as iMile's map leaves it.
    expect(event('2026-11-21T14:42:00+01:00', 'The pick-up task has been cancelled.')).toMatchObject({ stage_source: 'none' });
    expect(statusMapAnswer({ carrier: 'unknown', description: 'The pick-up task has been cancelled.' })).toMatchObject({ kind: 'intentional_gap' });
  });

  it("reads PTT's scans in ParcelsApp's English as PTT's map reads the Turkish", () => {
    for (const [wording, stage] of [['Handed to the delivery person', 'out_for_delivery'],
      ['Delivery not available at address/Closed - Notice left', 'failed_attempt'], ['Example PTT Waiting at the Workplace', 'ready_for_pickup']] as const) {
      expect(event('2026-11-11T09:45:00+03:00', wording), wording).toMatchObject({ stage, stage_source: 'wording:provider' });
      expect(statusMapAnswer({ carrier: 'unknown', description: wording }), wording).toMatchObject({ stage });
    }
    // Another office's wording is not PTT's.
    expect(event('2026-11-11T09:45:00+03:00', 'Waiting at the workplace')).toMatchObject({ stage_source: 'none' });
  });

  it("reads a warehouse order's creation as registered and leaves its packing and invoice without a stage, as Ship24 relays them", () => {
    expect(event('2026-11-11T01:45:00+01:00', 'Created')).toMatchObject({ stage: 'registered', stage_source: 'wording:provider' });
    expect(statusMapAnswer({ carrier: 'unknown', description: 'Created' })).toMatchObject({ stage: 'registered' });
    for (const wording of ['Packed', 'Pack Start', 'Invoiced']) {
      expect(event('2026-11-11T01:45:00+01:00', wording), wording).toMatchObject({ stage_source: 'none' });
      expect(statusMapAnswer({ carrier: 'unknown', description: wording }), wording).toMatchObject({ kind: 'intentional_gap' });
    }
    // A delivery day or a retail outlet the recipient chose, and a delivery planned for a weekday, are no steps either.
    for (const wording of ['Preferred day ordered.', 'The recipient has selected a retail outlet as the new delivery address.', 'Livraison prévue lundi prochain']) {
      expect(statusMapAnswer({ carrier: 'unknown', description: wording }), wording).toMatchObject({ kind: 'intentional_gap' });
    }
    // A creation that names something else stays unread.
    expect(event('2026-11-11T01:45:00+01:00', 'Created return')).toMatchObject({ stage_source: 'none' });
  });

  it("reads DHLink's export declaration and its warehouse in China, as providers relay them", () => {
    for (const wording of ['出口申报完成', '您的物品已到达华东仓', '您的物品已离开华东仓']) {
      expect(event('2026-01-07T12:45:00+08:00', wording), wording).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    expect(event('2026-01-07T12:45:00+08:00', '您的物品已离开')).toMatchObject({ stage: 'pending', stage_source: 'none' });
  });

  it("reads JETSPEED's rows as its own map reads them, as 17TRACK relays them", () => {
    expect(event('2026-11-18T19:09:00Z', 'Shipment entered the local delivery network.')).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    expect(event('2026-11-10T18:57:00Z', 'Shipment information has been received for destination processing. .'))
      .toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    expect(event('2026-11-02T05:41:00Z', 'Consignment received at the local warehouse in Example, CA.'))
      .toMatchObject({ stage: 'accepted', stage_source: 'wording:provider' });
  });

  it("reads a forwarder's wait at the airport for its flight and the flight's take-off, as providers relay them", () => {
    for (const wording of ['Wait for a flight', 'Waiting for the flight', 'The airline has taken off.']) {
      expect(event('2026-01-07T12:45:00+08:00', wording), wording).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    // A flight still to be booked is no wait at the airport.
    expect(event('2026-01-07T12:45:00+08:00', 'Wait for a flight to be booked')).toMatchObject({ stage_source: 'none' });
  });

  it("reads a line's truck towards the airport and its hand-over to the airlines, as ParcelsApp relays them", () => {
    for (const wording of ['On truck', 'Handovered to airlines']) {
      expect(event('2026-01-07T12:45:00+08:00', wording), wording).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    // A truck named in a longer sentence is not this scan.
    expect(event('2026-01-07T12:45:00+08:00', 'On truck for delivery')).not.toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
  });

  it("reads Suhu's operation centre sending the parcel on, an office of exchange's receipt and a facility's by its code, as providers relay them", () => {
    for (const wording of ['Cargo leaves operation center', 'Received at office of exchange', 'Parcel received by ABC01.']) {
      expect(event('2026-01-07T12:45:00+08:00', wording), wording).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe('in_transit');
    }
    // A person who received the parcel is no facility's code.
    expect(event('2026-01-07T12:45:00+08:00', 'Parcel received by Sample')).not.toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
  });

  it("reads GLS Italy's depot notices as a provider words them, in working days", () => {
    for (const wording of ['Area served in 48 hours, we will deliver within the next two working days.', 'Delivery scheduled for the next working day']) {
      expect(event('2026-01-07T12:45:00+01:00', wording), wording).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
      expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe('in_transit');
    }
  });

  it("reads HuaHan's pallet broken down after the flight and its transfer to the last mile's number, and a return, as providers relay them", () => {
    for (const wording of ['Dismantling in progress', '拆板中。—Dismantling in progress', 'Re-route: 1Z9K99F99999999999']) {
      expect(event('2026-01-07T12:45:00+08:00', wording), wording).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    // Beside the carrier's "RETURN TO SENDER", at the same instant.
    expect(event('2026-01-07T12:45:00+08:00', 'Parcel returning')).toMatchObject({ stage: 'exception', stage_source: 'wording:provider' });
    // A recipient's redirection of a delivery names no number of its own.
    expect(classifyEvent('Re-route requested by receiver').stage).not.toBe('in_transit');
  });

  it("reads 360Lion's hand-over to the last mile abroad, as ParcelsApp relays it", () => {
    // 360Lion's own tracker words the Argentine last mile's intake "handover to lastmile" (WSD02), beside its
    // Spanish "Recibido(Ya recibió el paquete.)", a second before the station's arrival.
    for (const wording of ['Handover to LM', 'handover to lastmile', 'Hand over to last mile', 'Recibido(Ya recibió el paquete.)']) {
      expect(event('2026-01-07T12:45:00-03:00', wording), wording).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    // A bare "Recibido" can be the recipient's receipt.
    expect(event('2026-01-07T12:45:00-03:00', 'Recibido')).not.toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
  });

  it("reads a sender's despatch to Couriers Please as the carrier's acceptance, as ParcelsApp relays it", () => {
    for (const wording of ['Despatched to CouriersPlease', 'Despatched to Couriers Please']) {
      expect(event('2026-01-07T13:00:00+11:00', wording), wording).toMatchObject({ stage: 'accepted', stage_source: 'wording:language' });
    }
    // One still to come is no hand-over.
    expect(classifyEvent('Your parcel will be despatched to CouriersPlease').stage).not.toBe('accepted');
  });

  it("reads Landmark Global's pallet for any crossing, and a destination carrier's pre-alert, as ParcelsApp relays them", () => {
    for (const wording of ['Grouped when pallet scanned to crossing (SLC INTERPOST #1)', 'Grouped when pallet scanned to crossing (DDU #1234)']) {
      expect(event('2026-01-07T12:45:00-07:00', wording)).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    expect(event('2026-01-07T12:45:00-07:00', 'Grouped when pallet scanned to crossing (SLC INTERPOST #1A)')).toMatchObject({ stage_source: 'none' });
    for (const wording of ['Carrier Prealert. Generated', 'Carrier Prealert. Sin recepción']) {
      expect(event('2026-01-07T12:45:00+01:00', wording)).toMatchObject({ stage: 'registered', stage_source: 'wording:provider' });
    }
  });

  it("reads 17TRACK's earlier wording of the airline taking China Post's dispatch as transit, as its later one", () => {
    for (const wording of ['Carrier received shipment', 'Received by carrier', 'Received by carrier [CN]']) {
      expect(event('2026-01-07T12:45:00+08:00', wording)).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
  });

  it('reads a relayed "Carrier received the shipment" of no named carrier as registration, and as transit after a movement', () => {
    expect(event('2026-01-07T12:45:00+08:00', 'Carrier received the shipment')).toMatchObject({ stage: 'registered', stage_source: 'wording:provider' });
  });

  it("reads ePost Global's pickup and tender to USPS, and USPS's export dispatch, as ParcelsApp relays them", () => {
    for (const wording of ['Outbound Shipment Pickup', 'Tendered to Postal Service', 'INTERNATIONAL DISPATCH READY']) {
      expect(event('2026-01-07T12:45:00-08:00', wording), wording).toMatchObject({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
  });

  it("reads USPS's shipping partner moving an item before USPS has it as providers relay it, not as a label", () => {
    for (const wording of ['Departed Shipping Partner Facility, USPS Awaiting Item', 'Arrived Shipping Partner Facility, USPS Awaiting Item',
      'Departed Shipping Partner Facility, EXAMPLE CITY, KY 12345',
      'Departed Shipping Partner Facility -> Your item departed a shipping partner facility at 6:00 pm on November 18, 2026 in EXAMPLE CITY, KY 12345. A delivery date will be provided when USPS receives the package.']) {
      expect(event('2026-11-18T18:00:00-05:00', wording)?.stage, wording).toBe('in_transit');
    }
    expect(event('2026-11-18T18:00:00-05:00', 'Picked Up by Shipping Partner, USPS Awaiting Item')?.stage).toBe('accepted');
  });

  it("reads Interpost's import clearance by its caption, without the status code ParcelsApp heads it with", () => {
    expect(event('2026-01-07T12:45:00+01:00', 'B2C Clearance 4. Customs Import cleared'))
      .toMatchObject({ description: 'Customs Import cleared', stage: 'in_transit' });
    // The code alone has no caption to show instead.
    expect(event('2026-01-07T12:45:00+01:00', 'B2C Clearance 4.')?.description).toBe('B2C Clearance 4.');
    expect(event('2026-01-07T12:45:00+01:00', 'Customs Clearance. Customs Import submitted')?.description)
      .toBe('Customs Clearance. Customs Import submitted');
  });

  it("reads DHL parcels' planned delivery as transit and leaves out the notice of its details, as ParcelsApp relays them", () => {
    for (const wording of ['Delivery Planned In Route', 'Delivery planned in the route of the courier', 'Delivery planned at the CityHub']) {
      expect(classifyEvent(wording), wording).toEqual({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    expect(classifyEvent('Information On Delivery Transmitted').stage_source).toBe('none');
    expect(statusMap.gaps.some(({ wording }) => wording === 'information on delivery transmitted')).toBe(true);
    // The note that DHL told the recipient of the delivery's details is no step either.
    const notified = 'The recipient has been notified (e.g. via email) about delivery details and available services';
    expect(classifyEvent(notified).stage_source).toBe('none');
    expect(statusMap.gaps.some(({ wording }) => wording === normalizeStatusWording(notified))).toBe(true);
    // A planned delivery that names its day is no step the rule reads.
    expect(classifyEvent('Delivery planned for Example day').stage_source).toBe('none');
  });

  it('leaves a delivery booked for a date unstaged, as ParcelsApp relays it, and names it a gap', () => {
    const wording = 'Information - Booking (Scheduled delivery date). Info:Example 2026-01-08 Example';
    expect(classifyEvent(wording).stage_source).toBe('none');
    expect(statusMap.gapNote?.(null, normalizeStatusWording(wording))).toMatch(/^A delivery booked for a date/);
  });

  it("reads a shipment's data created, and GLS's parcel made ready for its collection, as registration", () => {
    for (const wording of ['Shipment was successfully created', 'The parcel was provided by the sender for collection by GLS.']) {
      expect(classifyEvent(wording), wording).toEqual({ stage: 'registered', stage_source: 'wording:provider' });
    }
  });

  it("reads DHL Parcel Spain's departure as Postal Ninja translates it, its place apart, as transit", () => {
    expect(classifyEvent('output of')).toEqual({ stage: 'in_transit', stage_source: 'wording:provider' });
    // Its data received, before the pickup, is the registration DHL eCommerce Iberia's own map reads.
    expect(classifyEvent('Shipment details received')).toEqual({ stage: 'registered', stage_source: 'wording:language' });
    expect(classifyEvent('output of the warehouse').stage_source).toBe('none');
  });

  it("reads BUFFALO's depot steps in South Africa as transit, and leaves its bare \"Returns\" unread", () => {
    for (const wording of ['EX DC received the parcel', 'Receive in [Example TownDC]', 'Pack completed in [EXDC][DCZZ00000000]',
      'Outbound and start the next transfer phase', 'Floor scan']) {
      expect(classifyEvent(wording), wording).toEqual({ stage: 'in_transit', stage_source: 'wording:provider' });
    }
    expect(classifyEvent('Returns').stage_source).toBe('none');
  });

  it('keeps a pickup code in traditional or simplified characters where the privacy check finds it', () => {
    // Synthetic rows: a provider's event keeps the code in its wording, and hosts hide it by this check.
    for (const wording of ['快件已到達驛站，取件碼：12-3-4567', '快件已到达驿站，取件码：12-3-4567']) {
      const scan = event('2026-11-03T10:21:00Z', wording);
      expect(scan?.description).toContain('4567');
      expect(hasPrivateDeliveryDetails(scan?.description ?? '')).toBe(true);
    }
  });
});

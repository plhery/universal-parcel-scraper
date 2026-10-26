import { describe, expect, it } from 'vitest';
import { event, localEvent, result } from './result.js';

describe('shared provider result', () => {
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

  it("keeps no time for the seller's step when it is dated after the lookup", () => {
    const now = Date.now();
    const at = (offset: number) => new Date(now + offset).toISOString();
    const ahead = result([event(at(22 * 3_600_000), 'Pending shipping by the seller')!], 'ParcelsApp');
    expect(ahead).toMatchObject({ status: 'pending', current_stage: 'registered', last_update: null });
    expect(ahead.events).toHaveLength(1);
    expect(ahead.events?.[0]).not.toHaveProperty('time');
    // Dated before the lookup, it is the moment of the step.
    expect(result([event(at(-3_600_000), 'Pending shipping by the seller')!], 'ParcelsApp').events?.[0]?.time).toBe(at(-3_600_000));
    // Another scan dated ahead keeps its time, for the parcel app to flag.
    expect(result([event(at(22 * 3_600_000), 'Arrived at sorting center')!], 'ParcelsApp').events?.[0]?.time).toBe(at(22 * 3_600_000));
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

  it("reads a copy of SunYou's departure without the last-mile number, as SunYou's own result does", () => {
    expect(event('2026-01-07T12:45:00+08:00', 'Departed Sunyou Facility, Carrier Tracking Number:  ZZ000000005GB'))
      .toMatchObject({ description: 'Departed Sunyou Facility' });
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

  it("leaves out 17FEIA's estimated departure, written before the flight, so it cannot undo a customs step", () => {
    expect(event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18')).toBeNull();
    expect(event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18, OTHER', 'InTransit')).toBeNull();
    expect(localEvent('2026-01-07T09:16:18', 'Estimated departure date: 2026-01-08 17:16:18')).toBeNull();
    const customs = event('2026-01-07T08:20:00Z', 'Export declaration in progress.')!;
    expect(result([event('2026-01-07T09:16:18Z', 'Estimated departure date: 2026-01-08 17:16:18'), customs]
      .filter((scan) => scan !== null), 'ParcelsApp')).toMatchObject({ current_stage: 'customs' });
  });

  it("reads Interpost's import clearance by its caption, without the status code ParcelsApp heads it with", () => {
    expect(event('2026-01-07T12:45:00+01:00', 'B2C Clearance 4. Customs Import cleared'))
      .toMatchObject({ description: 'Customs Import cleared', stage: 'in_transit' });
    // The code alone has no caption to show instead.
    expect(event('2026-01-07T12:45:00+01:00', 'B2C Clearance 4.')?.description).toBe('B2C Clearance 4.');
    expect(event('2026-01-07T12:45:00+01:00', 'Customs Clearance. Customs Import submitted')?.description)
      .toBe('Customs Clearance. Customs Import submitted');
  });
});

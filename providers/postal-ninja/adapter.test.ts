// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrapeUniversalPage } from '../../core/transport/browser.js';
import { TrawlClient } from '../../core/transport/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, parsePostalNinjaResponse, PostalNinjaTracker } from './adapter.js';

vi.mock('../../core/transport/browser', () => ({ scrapeUniversalPage: vi.fn() }));

const number = 'ZZ12345678900';
interface Found { status: string; hid: string; track: { hid: string; tc: string; state: string; events: unknown[] } }
const found = JSON.parse(readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8')) as Found;
const withEvents = (events: unknown[]): Found => ({ ...found, track: { ...found.track, events } });

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('Postal Ninja result parsing', () => {
  it('preserves chronology and the carrier\'s wording without inventing time zones or reading the recipient\'s address', () => {
    const parsed = parsePostalNinjaResponse(found, number);
    expect(parsed).toMatchObject({ status: 'delivered', current_stage: 'delivered', tracking_provider: 'Postal Ninja' });
    // Wall-clock scans never fabricate a UTC instant, so the summary has no last_update.
    expect(parsed.last_update).toBeNull();
    // The delivery keeps its words, PIN included: a host shows them only to the parcel's owner.
    expect(parsed.events?.[0]).toEqual({ local_time: '2026-08-17T11:17:00', description: 'Delivered by Mailbox, PIN: PRIVATE', stage: 'delivered',
      stage_source: 'wording:provider', reporting_carrier: 'DPD' });
    expect(parsed.events?.[1]).toEqual({ local_time: '2026-08-17T07:22:00', description: 'Out for delivery', stage: 'out_for_delivery', stage_source: 'wording:provider',
      reporting_carrier: 'DPD' });
    // An explicit offset can be persisted as a real instant.
    expect(parsed.events?.[2]).toMatchObject({ time: '2026-08-16T04:00:00.000Z', stage: 'in_transit' });
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE street');
  });

  it('reads a CIS feed\'s warehouse steps and leaves out its data updates', () => {
    const parsed = parsePostalNinjaResponse(withEvents([
      { ds: 'Example', dt: '2026-08-12T08:00:00', dsc: 'Registered in the system' },
      { ds: 'Example', dt: '2026-08-12T10:00:00', dsc: 'Shipment parameters updated' },
      { ds: 'Example', dt: '2026-08-14T09:00:00', dsc: 'Inventory in a warehouse' },
    ]), number);
    expect(parsed.events?.map(({ description, stage }) => [description, stage])).toEqual([
      ['Inventory in a warehouse', 'in_transit'], ['Registered in the system', 'registered'],
    ]);
  });

  it("reads a line's receipt as the acceptance when no scan moved the parcel before it", () => {
    const stages = (events: unknown[]) => parsePostalNinjaResponse(withEvents(events), number).events?.map(({ description, stage }) => [description, stage]);
    expect(stages([
      { ds: 'Example', dt: '2026-11-06T08:00:00', dsc: 'Order information received' },
      { ds: 'Example', dt: '2026-11-06T16:23:13', dsc: 'Received by carrier' },
      { ds: 'Example', dt: '2026-11-07T05:27:58', dsc: 'Departed from sorting center' },
    ])).toEqual([['Departed from sorting center', 'in_transit'], ['Received by carrier', 'accepted'], ['Order information received', 'registered']]);
    expect(stages([
      { ds: 'Example', dt: '2026-11-06T08:00:00', dsc: 'Departed from sorting center' },
      { ds: 'Example', dt: '2026-11-06T16:23:13', dsc: 'Received by carrier' },
    ])).toEqual([['Received by carrier', 'in_transit'], ['Departed from sorting center', 'in_transit']]);
  });

  it("reads a marketplace's seller still packing the order as registered", () => {
    const parsed = parsePostalNinjaResponse(withEvents([{ ds: 'Example', dt: '2026-08-12T08:00:00',
      dsc: 'Awaiting shipping confirmation. The seller has already received your order and is preparing the packaging for shipping.' }]), number);
    expect(parsed.events?.[0]).toMatchObject({ stage: 'registered', stage_source: 'wording:language' });
  });

  it('leaves out a delivery day the recipient booked, as Hermes leaves it out of its history', () => {
    const parsed = parsePostalNinjaResponse(withEvents([
      { ds: 'Example', dt: '2026-08-12T08:00:00', dsc: 'Registered in the system' },
      { ds: 'Example', dt: '2026-08-13T16:39:00', dsc: 'A desired day for delivery has been booked' },
      { ds: 'Example', dt: '2026-08-14T09:00:00', dsc: 'Inventory in a warehouse' },
    ]), number);
    expect(parsed.events?.map(({ description }) => description)).toEqual(['Inventory in a warehouse', 'Registered in the system']);
  });

  it('names the services that reported the scans as carrier hints', () => {
    // A catalog carrier no detection rule claims the number for is still the hint (Raben's fifteen digits).
    const freight = '990000000000001';
    expect(parsePostalNinjaResponse({ ...found, track: { ...found.track, tc: freight, events: [
      { ds: 'Raben', dt: '2026-08-12T08:00:00', dsc: 'Registered in the system' },
      { ds: 'Raben', dt: '2026-08-14T09:00:00', dsc: 'Inventory in a warehouse' },
    ] } }, freight)).toMatchObject({ reported_carriers: ['Raben'], discovered_carrier: 'raben' });
    expect(parsePostalNinjaResponse(found, number)).toMatchObject({ reported_carriers: ['DPD'] });
    // A name outside the catalog may be the number's owner, so it leaves no hint.
    const other = parsePostalNinjaResponse(withEvents([{ ds: 'Example Unlisted Courier', dt: '2026-08-12T08:00:00', dsc: 'Collected' }]), number);
    expect(other.reported_carriers).toEqual(['Example Unlisted Courier']);
    expect(other.discovered_carrier).toBeUndefined();
  });

  it('names the service behind each scan and reads its wording by that carrier\'s map where the map reads it whole', () => {
    const scans = [
      { ds: 'PostNL', dt: '2026-08-12T08:00:00Z', dsc: 'Shipment received by PostNL' },
      { ds: 'PostNL', dt: '2026-08-13T08:00:00', dsc: 'Driver is en route' },
      { ds: 'Example', dt: '2026-08-13T09:00:00', dsc: 'Driver is en route' },
      { ds: 'Royal Mail', dt: '2026-08-14T08:00:00', dsc: 'Delivery request received' },
    ];
    const read = parsePostalNinjaResponse(withEvents(scans), number).events?.map(({ stage, stage_source, reporting_carrier }) =>
      [reporting_carrier, stage, stage_source]);
    expect(read).toEqual([
      // Royal Mail's map reads wording without a code by keywords, which would take this redelivery request for an
      // acceptance: the shared rules read it.
      ['Royal Mail', 'pending', 'none'],
      // A name outside the catalog is still named; the shared rules read its wording.
      ['Example', 'in_transit', 'wording:language'],
      // PostNL's domestic labels, which the shared rules read as in transit, on its wall clock and with its offset.
      ['PostNL', 'out_for_delivery', 'carrier_map'],
      ['PostNL', 'accepted', 'carrier_map'],
    ]);
    // Past the first ten names the hints keep, a catalog service staging its scan is still named on it.
    const crowded = [...Array.from({ length: 10 }, (_, index) => ({ ds: `Example ${index}`, dt: `2026-08-1${index}T08:00:00`, dsc: 'Sample note' })),
      { ds: 'PostNL', dt: '2026-08-20T08:00:00', dsc: 'Driver is en route' }];
    expect(parsePostalNinjaResponse(withEvents(crowded), number).events?.[0]).toMatchObject(
      { reporting_carrier: 'PostNL', stage: 'out_for_delivery', stage_source: 'carrier_map' });
  });

  const times = (parsed: { events?: { time?: string | null; local_time?: string | null }[] }) =>
    parsed.events?.map((scan) => scan.time ?? `local ${scan.local_time}`);
  const postal = (tc: string, destCn: string | undefined, events: unknown[]) =>
    ({ ...found, track: { ...found.track, tc, ...(destCn ? { destCn } : {}), events } });

  it('reads a service that Postal Ninja keeps on one clock in that clock, whatever the carrier\'s zone', () => {
    // Austrian Post's, Poste Italiane's and Raben's scans are UTC, not Vienna, Rome or Warsaw time.
    for (const [ds, zone] of [['Austrian Post', 'Europe/Vienna'], ['Poste Italiane', 'Europe/Rome'], ['Raben', 'Europe/Warsaw']]) {
      const scans = [{ ds, dt: '2026-08-17T07:22:00', dsc: 'Out for delivery' }, { ds, dt: '2026-08-17T11:17:00', dsc: 'Delivered' }];
      expect(times(parsePostalNinjaResponse(withEvents(scans), number, zone))).toEqual(['2026-08-17T11:17:00.000Z', '2026-08-17T07:22:00.000Z']);
    }
    // Australia Post's scans abroad are on Sydney's clock, not the origin's.
    const sydney = [{ ds: 'Australia Post', dt: '2026-11-20T19:15:00', dsc: 'Cleared and awaiting international departure' },
      { ds: 'Australia Post', dt: '2026-11-20T03:40:00', dsc: 'Received item from Sender (Outbound)' }];
    expect(times(parsePostalNinjaResponse(withEvents(sydney), number, 'Europe/London')))
      .toEqual(['2026-11-20T08:15:00.000Z', '2026-11-19T16:40:00.000Z']);
    // GOFO's clock follows its network, named by the destination.
    const gofo = (destCn?: string) => postal(number, destCn, [{ ds: 'GOFO Express', dt: '2026-08-17T11:17:00', dsc: 'Delivered' }]);
    expect(parsePostalNinjaResponse(gofo('US'), number).last_update).toBe('2026-08-17T18:17:00.000Z');
    expect(parsePostalNinjaResponse(gofo('FR'), number).last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(gofo(), number).last_update).toBeNull();
    // The Chinese forwarders before GOFO France write Beijing's wall clock, not the parcel's carrier's.
    const forwarded = postal(number, 'FR', [
      { ds: 'Zhongzhou Logistics', dt: '2026-11-02T17:10:04', dsc: '货物离开操作中心' },
      { ds: 'DHLink', dt: '2026-11-02T17:10:04', dsc: 'Goods leave the operations center' },
      { ds: 'GOFO Express', dt: '2026-11-02T11:01:35', dsc: 'Your package is being prepared by the sender.' },
    ]);
    expect(times(parsePostalNinjaResponse(forwarded, number, 'Europe/Paris')))
      .toEqual(['2026-11-02T10:01:35.000Z', '2026-11-02T09:10:04.000Z', '2026-11-02T09:10:04.000Z']);
    // Without GOFO, DHLink's clock is not known here and borrows the carrier's.
    const alone = postal(number, 'FR', [{ ds: 'DHLink', dt: '2026-11-02T17:10:04', dsc: 'Goods leave the operations center' },
      { ds: 'Royal Mail', dt: '2026-11-03T10:00:00', dsc: 'Delivered' }]);
    expect(times(parsePostalNinjaResponse(alone, number, 'Europe/Paris'))?.[1]).toBe('2026-11-02T16:10:04.000Z');
  });

  it('reads the UTC suffix Postal Ninja writes on Russian Post\'s scans as no zone', () => {
    const domestic = '10009999999980';
    const scans = [
      { ds: 'Russian Post', dt: '2026-10-16T11:30:40Z', dsc: 'Done. Accepted at the post office' },
      { ds: 'Russian Post', dt: '2026-10-17T15:02:10Z', dsc: 'Arrived at the sorting center' },
    ];
    // The office's wall clock: a history Russian Post reports alone is read on its clock, Moscow's.
    expect(times(parsePostalNinjaResponse(postal(domestic, 'RU', scans), domestic)))
      .toEqual(['2026-10-17T12:02:10.000Z', '2026-10-16T08:30:40.000Z']);
    // Beside another service, with no carrier zone to borrow, it keeps its wall clock.
    const relayed = [{ ds: 'Example', dt: '2026-10-15T10:00:00Z', dsc: 'Order received' }, ...scans];
    expect(times(parsePostalNinjaResponse(postal(domestic, 'RU', relayed), domestic)))
      .toEqual(['local 2026-10-17T15:02:10', 'local 2026-10-16T11:30:40', '2026-10-15T10:00:00.000Z']);
  });

  it('places a fixed clock\'s scans beside other services\', which borrow the carrier\'s zone or keep their wall times', () => {
    // Swiss Post keeps Zurich time for its own scans, and the destination post's
    // clock for those it relays from it; the other services relay the same scans
    // at clocks of their own, unknown here.
    const item = 'RR123456785CH';
    const reply = postal(item, 'SV', [
      { ds: 'DHL Germany', dt: '2026-08-12T08:05:00', dsc: 'Posting/Collection' },
      { ds: 'Swiss Post', dt: '2026-08-12T10:05:00', dsc: 'Time at which your consignment was mailed' },
      { ds: 'Swiss Post', dt: '2026-08-16T15:30:00', dsc: 'Arrival in destination country' },
      { ds: 'Example Post', dt: '2026-08-16T21:30:00', dsc: 'Receive shipment at exchange office' },
    ]);
    const unplaced = parsePostalNinjaResponse(reply, item);
    expect(times(unplaced)).toEqual(['local 2026-08-16T21:30:00', '2026-08-16T21:30:00.000Z',
      '2026-08-12T08:05:00.000Z', 'local 2026-08-12T10:05:00']);
    // The newest scan has no instant, so an older one does not stand in for it.
    expect(unplaced.last_update).toBeNull();
    // With the carrier's zone, the others' scans borrow it: a guess, two hours
    // early for the other post's here, and right for DHL Germany's, written in
    // UTC from Berlin's clock.
    expect(times(parsePostalNinjaResponse(reply, item, 'Europe/Zurich'))).toEqual(['2026-08-16T21:30:00.000Z', '2026-08-16T19:30:00.000Z',
      '2026-08-12T08:05:00.000Z', '2026-08-12T08:05:00.000Z']);
    // A destination on several clocks leaves Swiss Post's relays on Zurich time, the last guess.
    const delivered = (destCn: string) => parsePostalNinjaResponse(postal(item, destCn, [{ ds: 'Swiss Post', dt: '2026-08-17T11:17:00', dsc: 'Delivered' }]),
      item).last_update;
    expect([delivered('SV'), delivered('US')]).toEqual(['2026-08-17T17:17:00.000Z', '2026-08-17T09:17:00.000Z']);
  });

  it('reads Correos de El Salvador\'s scans in UTC, and its copies of the origin post\'s on that office\'s clock', () => {
    // As its own tracker dates them: UPU has the delivery round at 12:26 in El Salvador, -06:00,
    // and Swiss Post the departure from Geneva at 12:20 Zurich time.
    const item = 'RR123456785CH';
    const reply = postal(item, 'SV', [
      { ds: 'Correos de El Salvador', dt: '2026-09-03T12:20:00', dsc: 'Receive shipment at exchange office (departure)', loc: 'CHGVAC' },
      { ds: 'Swiss Post', dt: '2026-09-03T12:20:28', dsc: 'Forwarding abroad', loc: 'Example, 000000, Switzerland' },
      { ds: 'Swiss Post', dt: '2026-10-06T06:45:39', dsc: 'Enquiry initiated', loc: 'Switzerland' },
      { ds: 'Swiss Post', dt: '2026-10-08T12:26:00', dsc: 'Sorting - forwarding' },
      { ds: 'Correos de El Salvador', dt: '2026-10-08T18:26:18', dsc: 'Transfer shipment to delivery agent (inbound)', loc: 'SAN BENEDICT' },
    ]);
    expect(times(parsePostalNinjaResponse(reply, item, 'Europe/Zurich'))).toEqual(['2026-10-08T18:26:18.000Z',
      '2026-10-08T18:26:00.000Z', '2026-10-06T04:45:39.000Z', '2026-09-03T10:20:28.000Z', '2026-09-03T10:20:00.000Z']);
    // From an origin on several clocks a copy borrows the carrier's zone, a guess, not the post's UTC.
    const us = 'RR123456785US';
    expect(times(parsePostalNinjaResponse(postal(us, 'SV', [
      { ds: 'Correos de El Salvador', dt: '2026-09-03T12:20:00', dsc: 'Insert shipment into bag (output)', loc: 'USJFKA' },
      { ds: 'Correos de El Salvador', dt: '2026-09-24T21:30:17', dsc: 'Receive shipment at exchange office (entrance)' },
    ]), us, 'America/New_York'))).toEqual(['2026-09-24T21:30:17.000Z', '2026-09-03T16:20:00.000Z']);
  });

  it('reads DHL Germany\'s scans as the office\'s wall clock read on Berlin\'s and written in UTC', () => {
    // Royal Mail's own scans: leaving Belfast at 00:11 summer time, with customs in Milan at 00:01 and 23:06.
    const item = 'RR123456785GB';
    const reply = postal(item, 'IT', [
      { ds: 'DHL Germany', dt: '2026-10-05T22:11:00', dsc: 'Departure from outward office of exchange', loc: 'GBBELC' },
      { ds: 'DHL Germany', dt: '2026-10-12T22:01:00', dsc: 'Held by customs', loc: 'ITMILR' },
      { ds: 'DHL Germany', dt: '2026-10-14T21:06:00', dsc: 'Held by customs', loc: 'ITMILR' },
    ]);
    // Neither the carrier's zone nor its absence moves them.
    for (const zone of ['Europe/London', null]) {
      expect(times(parsePostalNinjaResponse(reply, item, zone))).toEqual(['2026-10-14T21:06:00.000Z',
        '2026-10-12T22:01:00.000Z', '2026-10-05T23:11:00.000Z']);
    }
    // An office outside Europe is on its clock too; a scan that names none keeps that wall clock, or borrows a zone.
    const abroad = (loc: string) => postal(item, 'IT', [{ ds: 'DHL Germany', dt: '2026-10-05T22:11:00', dsc: 'Departure from outward office of exchange', loc }]);
    expect(times(parsePostalNinjaResponse(abroad('CNBJSA'), item))).toEqual(['2026-10-05T16:11:00.000Z']);
    expect(times(parsePostalNinjaResponse(abroad(''), item))).toEqual(['local 2026-10-06T00:11:00']);
    // DHL's own scans in Germany, unplaced, are at their UTC digits: an arrival at 10:40 Berlin time comes at 09:40.
    const german = 'RR123456785AU';
    expect(times(parsePostalNinjaResponse(postal(german, 'DE', [{ ds: 'DHL Germany', dt: '2026-11-05T09:40:00', dsc: 'Item at sorting centre' }]),
      german, 'Europe/Berlin'))).toEqual(['2026-11-05T09:40:00.000Z']);
  });

  it('gives Royal Mail\'s Australian and American scans, after it leaves the UK, the wall clock under Royal Mail\'s label', () => {
    // Australia Post's arrival at customs at 10:04 Sydney summer time, labelled +09:30 by Royal Mail, came at 00:34 UK time.
    const item = 'RR123456785GB';
    const scans = [
      { ds: 'Royal Mail', dt: '2026-11-13T18:52:00', dsc: 'Item Received' },
      { ds: 'Royal Mail', dt: '2026-11-14T06:50:00', dsc: 'Item Leaving the UK' },
      { ds: 'Royal Mail', dt: '2026-11-18T00:34:00', dsc: 'Item Received' },
    ];
    expect(times(parsePostalNinjaResponse(postal(item, 'AU', scans), item, 'Europe/London')))
      .toEqual(['local 2026-11-18T10:04:00', '2026-11-14T06:50:00.000Z', '2026-11-13T18:52:00.000Z']);
    // Bound for the United States, they are USPS's, which Royal Mail labels with Eastern standard time: the receipt at its
    // international service centre at 07:39 in Los Angeles came at 12:39 UK time.
    const american = [...scans.slice(0, 2), { ds: 'Royal Mail', dt: '2026-11-18T12:39:00', dsc: 'Item Received' }];
    expect(times(parsePostalNinjaResponse(postal(item, 'US', american), item, 'Europe/London'))?.[0]).toBe('local 2026-11-18T07:39:00');
    // Bound elsewhere, or before the scan leaving the UK, Royal Mail's scans keep the UK's clock.
    expect(times(parsePostalNinjaResponse(postal(item, 'NZ', scans), item, 'Europe/London'))?.[0]).toBe('2026-11-18T00:34:00.000Z');
    expect(times(parsePostalNinjaResponse(postal(item, 'AU', [scans[0], scans[2]]), item, 'Europe/London'))?.[0])
      .toBe('2026-11-18T00:34:00.000Z');
  });

  it('reads Spring GDS\'s scans at the feed\'s digits, without the copies Postal Ninja gave an hour or two ahead before', () => {
    // Spring GDS's sorting at 14:18 Dutch time came at 14:18, beside its former copy at 15:18, and in summer at 16:18.
    // Spring GDS's acceptance, to the second, is an instant.
    const scans = [
      { ds: 'Spring GDS', dt: '2026-11-11T11:10:42', dsc: 'ACCEPTANCE' },
      { ds: 'Spring GDS', dt: '2026-11-13T14:18:00', dsc: 'AT TRANSFER DEPOT LMC. PARCEL RECEIVED BY POSTNL' },
      { ds: 'Spring GDS', dt: '2026-11-13T15:18:00', dsc: 'AT TRANSFER DEPOT LMC. PARCEL RECEIVED BY POSTNL' },
      // Another scan an hour later is a scan.
      { ds: 'Spring GDS', dt: '2026-11-13T15:18:00', dsc: 'AT TRANSFER DEPOT LMC. PARCEL AT POSTNL SORTING CENTRE' },
    ];
    const parsed = parsePostalNinjaResponse(withEvents(scans), number, 'Europe/Amsterdam', 'spring-gds');
    expect(times(parsed)).toEqual(['2026-11-13T14:18:00.000Z', '2026-11-13T13:18:00.000Z', '2026-11-11T10:10:42.000Z']);
    expect(parsed.events?.map((scan) => [scan.time_zone, scan.time_zone_basis])).toEqual(Array(3).fill(['Europe/Amsterdam', 'carrier']));
    expect(times(parsePostalNinjaResponse(withEvents([
      { ds: 'Spring GDS', dt: '2026-07-13T14:18', dsc: 'CROSSDOCK. PROCESSED AT POSTNL SORTING CENTRE' },
      { ds: 'Spring GDS', dt: '2026-07-13T16:18', dsc: 'CROSSDOCK. PROCESSED AT POSTNL SORTING CENTRE' },
    ]), number, 'Europe/Amsterdam', 'spring-gds'))).toEqual(['2026-07-13T12:18:00.000Z']);
    // Another service's scans to the minute are all kept.
    expect(times(parsePostalNinjaResponse(withEvents([{ ds: 'PostNL', dt: '2026-11-13T14:18:00', dsc: 'Sorted' },
      { ds: 'PostNL', dt: '2026-11-13T15:18:00', dsc: 'Sorted' }]), number, 'Europe/Amsterdam')))
      .toEqual(['2026-11-13T14:18:00.000Z', '2026-11-13T13:18:00.000Z']);
  });

  it('reads PostNL\'s scans it names PostNL on a Spring GDS item at the feed\'s digits, and the UTC digits of its customs and acceptance stamps', () => {
    // The pre-advice at 09:25 Dutch time came at 09:25, the pre-declaration at 12:37:33Z at 12:37:33, the acceptance at
    // 07:53:24Z at 07:53:24. An acceptance to the minute and a sorting scan to the second are local.
    const scans = [
      { ds: 'PostNL', dt: '2026-03-04T09:25:00', dsc: 'The item is pre-advised to PostNL' },
      { ds: 'PostNL', dt: '2026-03-04T12:37:33', dsc: 'Pre-declaration of the item has been received by customs', loc: 'Netherlands' },
      { ds: 'PostNL', dt: '2026-03-05T07:53:24', dsc: 'Consignment received at the PostNL Acceptance Centre', loc: 'Netherlands' },
      { ds: 'PostNL', dt: '2026-03-06T13:46:00', dsc: 'Consignment received at the PostNL Acceptance Centre', loc: 'Netherlands' },
      { ds: 'PostNL', dt: '2026-03-07T14:01:17', dsc: 'The item is at the local sorting centre', loc: 'Netherlands' },
    ];
    const parsed = parsePostalNinjaResponse(withEvents(scans), number, 'Europe/Amsterdam', 'spring-gds');
    expect(times(parsed)).toEqual(['2026-03-07T13:01:17.000Z', '2026-03-06T12:46:00.000Z', '2026-03-05T07:53:24.000Z',
      '2026-03-04T12:37:33.000Z', '2026-03-04T08:25:00.000Z']);
    expect(parsed.events?.map((scan) => scan.time_zone ?? null))
      .toEqual(['Europe/Amsterdam', 'Europe/Amsterdam', null, null, 'Europe/Amsterdam']);
    // Cainiao's copy of the acceptance stamp has its UTC digits; its copy of a local scan its local ones.
    const copies = [
      { ds: 'PostNL', dt: '2026-11-18T07:53:24', dsc: 'Consignment received at the PostNL Acceptance Centre', loc: 'Netherlands' },
      { ds: 'Cainiao', dt: '2026-11-18T07:53:24', dsc: 'Arrived at transit country or region' },
      { ds: 'PostNL', dt: '2026-11-20T14:01:17', dsc: 'The item is at the local sorting centre', loc: 'Netherlands' },
      { ds: 'Cainiao', dt: '2026-11-20T14:01:00', dsc: 'Arrived at local delivery center' },
    ];
    expect(times(parsePostalNinjaResponse(withEvents(copies), number, 'Europe/Amsterdam', 'spring-gds'))).toEqual([
      '2026-11-20T13:01:17.000Z', '2026-11-20T13:01:00.000Z', '2026-11-18T07:53:24.000Z', '2026-11-18T07:53:24.000Z']);
    expect(times(parsePostalNinjaResponse(withEvents(copies), number, 'Europe/Amsterdam', 'postnl'))?.[3]).toBe('2026-11-18T06:53:24.000Z');
    // On a lookup for PostNL itself they keep their digits.
    expect(times(parsePostalNinjaResponse(withEvents(scans), number, 'Europe/Amsterdam', 'postnl'))).toEqual(['2026-03-07T13:01:17.000Z',
      '2026-03-06T12:46:00.000Z', '2026-03-05T06:53:24.000Z', '2026-03-04T11:37:33.000Z', '2026-03-04T08:25:00.000Z']);
  });

  it('keeps the UTC digits of PostNL\'s label and processing record through Spring GDS, which PostNL stamps in UTC to the minute', () => {
    const scans = [
      { ds: 'Spring GDS', dt: '2026-03-01T18:13:00', dsc: 'The shipping label has been created' },
      // A sorting scan is PostNL's local time.
      { ds: 'Spring GDS', dt: '2026-03-12T16:12:00', dsc: 'The item is processed at the PostNL sorting center' },
      { ds: 'Spring GDS', dt: '2026-07-12T09:58:00', dsc: 'The item is being processed' },
      { ds: 'PostNL', dt: '2026-11-10T15:00:00', dsc: 'The shipping label has been created' },
    ];
    expect(times(parsePostalNinjaResponse(withEvents(scans), number, 'Europe/Amsterdam', 'spring-gds')))
      .toEqual(['2026-11-10T15:00:00.000Z', '2026-07-12T09:58:00.000Z', '2026-03-12T15:12:00.000Z', '2026-03-01T18:13:00.000Z']);
    // A processing record that names a place is a local scan like the others.
    expect(times(parsePostalNinjaResponse(withEvents([{ ds: 'Spring GDS', dt: '2026-07-12T11:58:00', dsc: 'The item is being processed',
      loc: 'Netherlands' }]), number, 'Europe/Amsterdam', 'spring-gds'))).toEqual(['2026-07-12T09:58:00.000Z']);
  });

  it('reads Cainiao\'s steps in China on China\'s clock, and lends it to none of its later scans', () => {
    // Cainiao's own feed dates these steps +08:00 at the same digits. On the Zurich
    // clock routing passes for a Swiss Post item they came six hours late.
    const item = 'LW123456785CH';
    const reply = postal(item, 'CH', [
      { ds: 'Cainiao', dt: '2026-08-05T16:46:11', dsc: 'Shipment information received electronically by the warehouse. Example text' },
      { ds: 'Cainiao', dt: '2026-08-05T23:37:10', dsc: 'Inbound processing in sorting center', loc: 'Example Town' },
      { ds: 'Cainiao', dt: '2026-08-06T16:39:00', dsc: 'Export customs clearance complete successfully' },
      { ds: 'Cainiao', dt: '2026-08-07T22:30:00', dsc: 'Leaving the origin country or region' },
      { ds: 'Cainiao', dt: '2026-08-08T05:07:00', dsc: 'Departed from the departure country or region' },
      // On either side's clock, as Cainiao's feed dates it: it borrows routing's zone, not China's.
      { ds: 'Cainiao', dt: '2026-08-08T15:09:00', dsc: 'Arrived at the linehaul office' },
      { ds: 'Swiss Post', dt: '2026-08-10T09:00:00', dsc: 'Sorting', loc: 'Example, 0000, Switzerland' },
    ]);
    expect(times(parsePostalNinjaResponse(reply, item, 'Europe/Zurich', 'swiss-post'))).toEqual([
      '2026-08-10T07:00:00.000Z', '2026-08-08T13:09:00.000Z', '2026-08-07T21:07:00.000Z', '2026-08-07T14:30:00.000Z',
      '2026-08-06T08:39:00.000Z', '2026-08-05T15:37:10.000Z', '2026-08-05T08:46:11.000Z',
    ]);
    // Cainiao names the sorting centre's town before some steps in China, in brackets.
    expect(times(parsePostalNinjaResponse(postal(item, 'CH', [{ ds: 'Cainiao', dt: '2026-08-05T10:31:23',
      dsc: '[Example Town] Package not accepted by sorting center' }]), item, 'Europe/Zurich', 'swiss-post'))).toEqual(['2026-08-05T02:31:23.000Z']);
    // Without a zone from routing, the step in China keeps its clock and the later scan its wall time.
    expect(times(parsePostalNinjaResponse(postal(item, 'CH', reply.track.events.slice(4, 6)), item))).toEqual([
      'local 2026-08-08T15:09:00', '2026-08-07T21:07:00.000Z',
    ]);
  });

  it('reads Cainiao\'s steps in the destination on its clock, and lends it to none of its steps at the transit hub', () => {
    // A PostNL item to the UK: Royal Mail received it at 12:24 UTC, when Cainiao dates its customs arrival 12:24. On the
    // Amsterdam clock routing passes for PostNL, the destination's steps came an hour early.
    const item = 'LA123456785NL';
    const reply = postal(item, 'GB', [
      { ds: 'Cainiao', dt: '2026-11-14T13:59:00', dsc: 'Arrived at transit country or region' },
      { ds: 'Cainiao', dt: '2026-11-23T12:24:00', dsc: 'Arrived at customs' },
      { ds: 'Cainiao', dt: '2026-11-23T12:24:00', dsc: 'Received by local delivery company' },
      { ds: 'Cainiao', dt: '2026-11-23T23:55:00', dsc: 'Arrived at the destination country or region sorting center' },
      { ds: 'Cainiao', dt: '2026-11-24T05:38:00', dsc: 'Out for delivery' },
    ]);
    const parsed = parsePostalNinjaResponse(reply, item, 'Europe/Amsterdam', 'spring-gds');
    expect(times(parsed)).toEqual(['2026-11-24T05:38:00.000Z', '2026-11-23T23:55:00.000Z', '2026-11-23T12:24:00.000Z',
      '2026-11-23T12:24:00.000Z', '2026-11-14T12:59:00.000Z']);
    expect(parsed.events?.map((scan) => [scan.time_zone, scan.time_zone_basis])).toEqual([
      ...Array.from({ length: 4 }, () => ['Europe/London', 'destination']), ['Europe/Amsterdam', 'carrier'],
    ]);
    // A destination of several clocks names none, and the step borrows routing's zone as before.
    expect(parsePostalNinjaResponse(postal(item, 'US', reply.track.events.slice(4)), item, 'America/New_York', 'spring-gds').events?.[0])
      .toMatchObject({ time: '2026-11-24T10:38:00.000Z', time_zone: 'America/New_York', time_zone_basis: 'carrier' });
  });

  it('reads 4PX\'s scans in China in UTC, and lends that clock to its scans that name no place', () => {
    // 4PX's own tracker dates the order data at 20:37:34 and the pickup at 21:08:31, both +08:00. Read on
    // the Berlin zone routing passes for the DHL Germany parcel they continue on, they came an hour early.
    const parcel = postal(number, 'FR', [
      { ds: '4PX Express', dt: '2026-11-15T12:37:34', dsc: 'Parcel information received' },
      { ds: '4PX Express', dt: '2026-11-15T13:08:31', dsc: 'Shipment picked up', loc: 'Example Warehouse, Guangdong, China' },
      { ds: '4PX Express', dt: '2026-11-15T13:08:32', dsc: 'Depart from facility to service provider.', loc: 'Example Warehouse, Guangdong, China' },
    ]);
    const parsed = parsePostalNinjaResponse(parcel, number, 'Europe/Berlin', 'dhl');
    expect(times(parsed)).toEqual(['2026-11-15T13:08:32.000Z', '2026-11-15T13:08:31.000Z', '2026-11-15T12:37:34.000Z']);
    expect(parsed.events?.map((scan) => scan.time_zone ?? null)).toEqual([null, null, null]);
    // Elsewhere its clock is not known, and its scans borrow the carrier's zone.
    const abroad = postal(number, 'US', [{ ds: '4PX Express', dt: '2026-11-15T13:08:31', dsc: 'Shipment picked up', loc: 'Example, CA, United States' }]);
    expect(times(parsePostalNinjaResponse(abroad, number, 'America/Los_Angeles'))).toEqual(['2026-11-15T21:08:31.000Z']);
  });

  it('orders scans by instant once every one has one', () => {
    // Postal Ninja orders wall times: 10:30 UTC sorts after 11:00 Zurich time.
    const parsed = parsePostalNinjaResponse(withEvents([
      { ds: 'Poste Italiane', dt: '2026-08-17T08:30:00', dsc: 'In transit' },
      { ds: 'Swiss Post', dt: '2026-08-17T11:00:00', dsc: 'Sorting' },
      { ds: 'Poste Italiane', dt: '2026-08-17T10:30:00', dsc: 'Delivered' },
    ]), number);
    expect(times(parsed)).toEqual(['2026-08-17T10:30:00.000Z', '2026-08-17T09:00:00.000Z', '2026-08-17T08:30:00.000Z']);
    expect(parsed).toMatchObject({ current_stage: 'delivered', last_update: '2026-08-17T10:30:00.000Z' });
  });

  it('reads a local clock only in a history its service reports alone within one country', () => {
    const scans = (ds: string) => [{ ds, dt: '2026-08-17T07:22:00', dsc: 'Out for delivery' }, { ds, dt: '2026-08-17T11:17:00', dsc: 'Delivered' }];
    // The service's own zone, else the destination's, else the carrier's.
    expect(times(parsePostalNinjaResponse(withEvents(scans('An Post Ireland')), number, 'Europe/Rome')))
      .toEqual(['2026-08-17T10:17:00.000Z', '2026-08-17T06:22:00.000Z']);
    expect(parsePostalNinjaResponse(postal(number, 'SE', scans('PostNord')), number).last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('DPD')), number, 'Europe/London').last_update).toBe('2026-08-17T10:17:00.000Z');
    // A carrier whose catalog zone is the UTC placeholder lends the clock of the
    // one country it serves to a local clock, never to a fixed one.
    expect(parsePostalNinjaResponse(withEvents(scans('DPD')), number, null, 'brt').last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('Poste Italiane')), number, null, 'brt').last_update).toBe('2026-08-17T11:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('DPD')), number, null, 'packeta').last_update).toBeNull();
    // A destination on another clock than the service's may be a parcel that
    // crossed a border, and a service whose clock is unknown has none: their
    // scans borrow the carrier's zone, else the one the service's name gives.
    expect(parsePostalNinjaResponse(postal(number, 'FR', scans('DPD UK')), number, 'Europe/Paris').last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(postal(number, 'FR', scans('DPD UK')), number).last_update).toBe('2026-08-17T10:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('Example Express')), number, 'Europe/Rome').last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(withEvents(scans('Example Express')), number).last_update).toBeNull();
  });

  it('reads a carrier on the clock of each scan\'s office by the state or province its location names', () => {
    const parsed = parsePostalNinjaResponse(withEvents([
      // No state, or no country to say IL is one: the office's clock is unknown,
      // and the scan borrows the zone of the nearest earlier one, else later one.
      { ds: 'UPS', dt: '2026-08-15T09:00:00', dsc: 'Shipper created a label', loc: 'United States' },
      { ds: 'UPS', dt: '2026-08-15T21:40:00', dsc: 'Arrived at Facility', loc: 'Mississauga, ON, L5T 2N7, Canada' },
      { ds: 'UPS', dt: '2026-08-16T08:05:00', dsc: 'Departed from Facility', loc: 'Atlanta, GA, United States' },
      { ds: 'UPS', dt: '2026-08-16T18:00:00', dsc: 'Departed from Facility', loc: 'Chicago, IL' },
      { ds: 'UPS', dt: '2026-08-17T11:17:00', dsc: 'Delivered', loc: 'TACOMA, WA, 12345, United States' },
    ]), number);
    expect(times(parsed)).toEqual(['2026-08-17T18:17:00.000Z', '2026-08-16T22:00:00.000Z', '2026-08-16T12:05:00.000Z',
      '2026-08-16T01:40:00.000Z', '2026-08-15T13:00:00.000Z']);
    expect(parsed.last_update).toBe('2026-08-17T18:17:00.000Z');
    // A pickup dated without a time is written as midnight, and UPS dates a scan
    // between midnight and 1 a.m. at 12:xx: no zone places either. A delivery
    // at 12:xx is read as afternoon.
    const memphis = (ds: string, dt: string, dsc: string) => ({ ds, dt, dsc, loc: 'MEMPHIS, TN, United States' });
    expect(times(parsePostalNinjaResponse(withEvents([
      memphis('FedEx', '2026-08-16T00:00:00', 'Picked up'),
      memphis('FedEx', '2026-08-16T12:25:00', 'Arrived at FedEx location'),
    ]), number, 'America/Chicago'))).toEqual(['2026-08-16T17:25:00.000Z', 'local 2026-08-16T00:00:00']);
    expect(times(parsePostalNinjaResponse(withEvents([
      memphis('UPS', '2026-08-16T12:25:00', 'Arrived at Facility'),
      memphis('UPS', '2026-08-16T13:25:00', 'Departed from Facility'),
      memphis('UPS', '2026-08-17T12:40:00', 'Delivered'),
    ]), number, 'America/Chicago'))).toEqual(['2026-08-17T17:40:00.000Z', '2026-08-16T18:25:00.000Z', 'local 2026-08-16T12:25:00']);
    // Beside another service, UPS's office clock is not read.
    expect(parsePostalNinjaResponse(withEvents([
      { ds: 'USPS', dt: '2026-08-17T10:00:00', dsc: 'Out for delivery', loc: 'ATLANTA, GA 30301' },
      { ds: 'UPS', dt: '2026-08-17T11:17:00', dsc: 'Delivered', loc: 'Atlanta, GA, United States' },
    ]), number).last_update).toBeNull();
  });

  it('places USPS\'s scans by their facility beside other services, and keeps those nothing places off a zone abroad', () => {
    const scans = [
      // PostNL's label, stamped in UTC to the minute: Postal Ninja gives its UTC digits.
      { ds: 'Spring GDS', dt: '2026-10-28T10:00:00', dsc: 'The shipping label has been created' },
      // No place: each borrows the Pacific clock of the nearest USPS scan that names its state.
      { ds: 'USPS', dt: '2026-11-02T03:00:29', dsc: 'Inbound into customs' },
      { ds: 'USPS', dt: '2026-11-02T16:45:00', dsc: 'Arrived at USPS Facility', loc: 'EXAMPLE CITY, CA 90001' },
      { ds: 'United States Postal Service', dt: '2026-11-03T06:05:00', dsc: 'Arrived at Post Office', loc: 'Example Town, CA, United States' },
      { ds: 'USPS', dt: '2026-11-03T06:10:00', dsc: 'Out for Delivery' },
    ];
    expect(times(parsePostalNinjaResponse(withEvents(scans), number, 'Europe/Amsterdam', 'spring-gds'))).toEqual([
      '2026-11-03T14:10:00.000Z', '2026-11-03T14:05:00.000Z', '2026-11-03T00:45:00.000Z', '2026-11-02T11:00:29.000Z',
      '2026-10-28T10:00:00.000Z',
    ]);
    // With no USPS scan to borrow from, its scan keeps its wall time rather than the Amsterdam zone of the carrier, and
    // borrows a US one.
    const unplaced = withEvents([scans[0], scans[1]]);
    expect(times(parsePostalNinjaResponse(unplaced, number, 'Europe/Amsterdam', 'spring-gds'))).toEqual([
      'local 2026-11-02T03:00:29', '2026-10-28T10:00:00.000Z',
    ]);
    expect(times(parsePostalNinjaResponse(unplaced, number, 'America/New_York'))).toEqual([
      '2026-11-02T08:00:29.000Z', '2026-10-28T10:00:00.000Z',
    ]);
    // A territory USPS delivers in keeps its own clock: Puerto Rico's, Guam's.
    expect(times(parsePostalNinjaResponse(unplaced, number, 'America/Puerto_Rico'))?.[0]).toBe('2026-11-02T07:00:29.000Z');
    expect(times(parsePostalNinjaResponse(unplaced, number, 'Pacific/Guam'))?.[0]).toBe('2026-11-01T17:00:29.000Z');
    // Each deduced instant names its zone and how it was chosen; the label's UTC stamp is the instant itself.
    expect(parsePostalNinjaResponse(withEvents(scans), number, 'Europe/Amsterdam', 'spring-gds').events!
      .map((scan) => [scan.time_zone, scan.time_zone_basis])).toEqual([
      ['America/Los_Angeles', 'neighbour'], ['America/Los_Angeles', 'place'], ['America/Los_Angeles', 'place'],
      ['America/Los_Angeles', 'neighbour'], [undefined, undefined],
    ]);
    // Nor a zone of another country with several clocks, or UTC.
    for (const zone of ['Australia/Sydney', 'America/Toronto', 'UTC']) {
      expect(times(parsePostalNinjaResponse(unplaced, number, zone))?.[0]).toBe('local 2026-11-02T03:00:29');
    }
    // A label is on its facility's clock, as USPS's adapter reads it.
    const label = withEvents([scans[0], { ds: 'USPS', dt: '2026-11-02T04:40:00', dsc: 'Shipping Label Created', loc: 'EXAMPLE CITY, CA 90001' }]);
    expect(parsePostalNinjaResponse(label, number, 'Europe/Amsterdam', 'spring-gds').events![0])
      .toMatchObject({ time: '2026-11-02T12:40:00.000Z', time_zone: 'America/Los_Angeles' });
    // The unplaced scan after it borrows that facility's clock.
    const labelled = withEvents([scans[0], { ds: 'USPS', dt: '2026-11-01T22:00:00', dsc: 'Shipping Label Created', loc: 'EXAMPLE CITY, CA 90001' },
      ...scans.slice(1, 3)]);
    expect(parsePostalNinjaResponse(labelled, number, 'Europe/Amsterdam', 'spring-gds').events!
      .find((scan) => scan.description === 'Inbound into customs')).toMatchObject({ time: '2026-11-02T11:00:29.000Z', time_zone: 'America/Los_Angeles' });
  });

  it('reads local clocks beside other services, or for a postal item that crosses a border, only in the carrier\'s zone', () => {
    // DHL Germany repeats the origin post's scans at the origin's clock, read on Berlin's and written in UTC.
    const relayed = withEvents([
      { ds: 'Example Post', dt: '2026-08-12T20:05:00', dsc: 'Posting/Collection' },
      { ds: 'DHL Germany', dt: '2026-08-12T18:05:00', dsc: 'Posting/Collection' },
      { ds: 'An Post Ireland', dt: '2026-08-17T11:17:00', dsc: 'Delivered' },
    ]);
    const unplaced = parsePostalNinjaResponse(relayed, number);
    expect(unplaced.last_update).toBeNull();
    expect(unplaced.events?.every((scan) => scan.local_time && !scan.time)).toBe(true);
    expect(times(parsePostalNinjaResponse(relayed, number, 'Europe/Dublin'))).toEqual(['2026-08-17T10:17:00.000Z', '2026-08-12T19:05:00.000Z']);
    const item = 'RR123456785SE';
    const delivered = [{ ds: 'PostNord', dt: '2026-08-17T11:17:00', dsc: 'Delivered' }];
    expect(parsePostalNinjaResponse(postal(item, 'NO', delivered), item).last_update).toBeNull();
    expect(parsePostalNinjaResponse(postal(item, 'SE', delivered), item).last_update).toBe('2026-08-17T09:17:00.000Z');
  });

  it('leaves out pickup deadlines', () => {
    const reply = (deadline: string, lastFetch?: string) => ({ ...found, track: { ...found.track, destCn: 'NO', ...(lastFetch ? { lastFetch } : {}), events: [
      { ds: 'Posten Norge', dt: '2026-08-17T11:17:00', dsc: 'The parcel has arrived at the pickup point' },
      { ds: 'Posten Norge', dt: '2026-08-24T10:00:00', dsc: deadline },
    ] } });
    const descriptions = (parsed: ReturnType<typeof parsePostalNinjaResponse>) => parsed.events?.map((scan) => scan.description);
    const arrived = ['The parcel has arrived at the pickup point'];
    expect(descriptions(parsePostalNinjaResponse(reply('Last day for retrieval'), number))).toEqual(arrived);
    // Any row dated after Postal Ninja last read the carrier is one too.
    const parsed = parsePostalNinjaResponse(reply('Will be returned to the sender', '2026-08-17T12:00:00Z'), number);
    expect(descriptions(parsed)).toEqual(arrived);
    expect(parsed.last_update).toBe('2026-08-17T09:17:00.000Z');
    expect(parsePostalNinjaResponse(reply('Will be returned to the sender'), number).events).toHaveLength(2);
  });

  it('accepts the widget compact response without inventing missing history', () => {
    const track = { ...found.track, events: undefined };
    const parsed = parsePostalNinjaResponse({ ...found, track: {
      ...track,
      firstEv: { dt: '2026-08-01T10:00:00', dsc: 'Shipment information received' },
      lastEv: { dt: '2026-08-17T11:17:00', dsc: 'Delivered by Mailbox, PIN: PRIVATE' },
      toAddress: 'PRIVATE RECIPIENT',
    } }, number);
    expect(parsed).toMatchObject({ current_stage: 'delivered', last_update: null });
    expect(parsed.events).toEqual([
      { local_time: '2026-08-17T11:17:00', description: 'Delivered by Mailbox, PIN: PRIVATE', stage: 'delivered', stage_source: 'wording:provider' },
      { local_time: '2026-08-01T10:00:00', description: 'Shipment information received', stage: 'registered', stage_source: 'wording:provider' },
    ]);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE RECIPIENT');
    // Two scans cannot show that one service reports the whole history: a local
    // clock's borrow the carrier's zone.
    const compact = (ds: string, zone: string | null) => parsePostalNinjaResponse({ ...found, track: { ...track,
      firstEv: { ds, dt: '2026-08-01T10:00:00', dsc: 'Accepted' }, lastEv: { ds, dt: '2026-08-17T11:17:00', dsc: 'Delivered' } } }, number, zone).last_update;
    expect(compact('DPD', null)).toBeNull();
    expect(compact('DPD', 'Europe/Rome')).toBe('2026-08-17T09:17:00.000Z');
    expect(compact('Swiss Post', null)).toBe('2026-08-17T09:17:00.000Z');
  });

  it('deduplicates a compact single scan and rejects malformed compact data', () => {
    const track = { ...found.track, events: undefined };
    const scan = { dt: '2026-08-17T11:17:00', dsc: 'In transit' };
    expect(parsePostalNinjaResponse({ ...found, track: { ...track, firstEv: scan, lastEv: scan } }, number).events).toHaveLength(1);
    for (const fields of [
      {}, { lastEv: 'invalid' }, { firstEv: scan, lastEv: { dt: 'invalid', dsc: 'Delivered' } },
      { events: null, firstEv: scan }, { events: [], lastEv: scan },
    ]) expect(() => parsePostalNinjaResponse({ ...found, track: { ...track, ...fields } }, number)).toThrow();
  });

  it('rejects challenges, wrong identities, empty history and malformed dates', () => {
    for (const payload of [
      { ...found, status: 'CHLNG_REQ' }, { ...found, hid: 'different' },
      { ...found, track: { ...found.track, tc: 'OTHER123' } },
      { ...found, track: { ...found.track, state: 'PRIVATE' } },
      withEvents([]), withEvents([null]),
      withEvents([{ dt: '2026-02-31T12:00:00', dsc: 'Delivered' }]),
      withEvents([{ dt: 'tomorrow', dsc: 'Delivered' }]),
      withEvents(Array(1001).fill({ dt: '2026-08-17T11:17:00', dsc: 'Delivered' })),
    ]) expect(() => parsePostalNinjaResponse(payload, number)).toThrow();
  });

  it('does not mark forecasts or carrier handoffs as final delivery', () => {
    for (const [description, stage] of [
      ['The package is being prepared by the sender and will be delivered to us soon', 'registered'],
      ['En route to DHL eCommerce distribution center or awaiting processing', 'registered'],
      ['En route', 'in_transit'], ['Delivered to local carrier', 'in_transit'],
    ]) expect(parsePostalNinjaResponse(withEvents([{ dt: '2026-08-17T11:17:00', dsc: description }]), number).current_stage).toBe(stage);
  });

  it("reads DHL Parcel Spain's departure, \"Salida de\" translated with its place apart, as transit", () => {
    const read = (dsc: string, loc?: string) => parsePostalNinjaResponse(withEvents([
      { ds: 'DHL Parcel Spain', dt: '2026-08-12T08:00:00', dsc: 'Shipment details received' },
      { ds: 'DHL Parcel Spain', dt: '2026-08-13T21:40:00', dsc, ...(loc ? { loc } : {}) },
    ]), number).events?.map(({ description, stage, stage_source }) => [description, stage, stage_source]);
    expect(read('Output of', 'EXAMPLE TOWN')).toEqual([
      ['Output of', 'in_transit', 'wording:provider'], ['Shipment details received', 'registered', 'wording:language'],
    ]);
    // The same words with the place joined into the text are no departure the rule reads.
    expect(read('Output of EXAMPLE TOWN')?.[0]).toEqual(['Output of EXAMPLE TOWN', 'pending', 'none']);
  });
});

describe('Postal Ninja TRAWL capture', () => {
  const get = 'https://postal.ninja/track/get';
  const check = 'https://postal.ninja/track/check';
  const url = `https://postal.ninja/en/tools#trawl-number=${number}`;
  const entry = (payload: unknown, endpoint = get, status = 200) => ({
    url: endpoint, status, body: JSON.stringify(payload), headers: { 'retry-after': '60' },
  });
  const captured = (entries: unknown[], overrides = {}) => new Response(JSON.stringify({
    url, html: '<html></html>', statusCode: 200, tier: 3, capturedResponses: entries, ...overrides,
  }));
  const setup = (response: Response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const trawl = new TrawlClient('http://browser.test', fetcher);
    return {fetcher, trawl, tracker: new PostalNinjaTracker({trawl})};
  };

  it('wires the shared browser service through the factory and requests both protocol endpoints', async () => {
    const {fetcher, trawl} = setup(captured([entry({status: 'PROCESSING', tc: number, hid: found.hid}, check), entry(found)]));
    const provider = adapter({trawl, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null});
    expect(provider.steps).toEqual(['trawl']);
    await expect(provider.track({number, postcode: null, timezone: 'Europe/Rome'}, {budgetMs: 30_000}))
      .resolves.toMatchObject({tracking_provider: 'Postal Ninja', current_stage: 'delivered', last_update: '2026-08-17T09:17:00.000Z'});
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({url, skipHttp: true, maxTier: 3, captureResponses: [get, check]});
    // The parcel's carrier reaches the parser too: BRT serves Italy alone.
    const brt = adapter({trawl: setup(captured([entry(found)])).trawl, recorder: NOOP_RECORDER, env: {}, browserExecutablePath: null});
    await expect(brt.track({number, postcode: null, timezone: null, carrier: 'brt'}, {budgetMs: 30_000}))
      .resolves.toMatchObject({last_update: '2026-08-17T09:17:00.000Z'});
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('skips unrelated and intermediate captures but preserves a matching challenge or no-info outcome', async () => {
    const noInfo = { ...found, track: { ...found.track, state: 'NO_INFO', events: [] } };
    for (const [entries, expected] of [
      [[entry({status: 'CHLNG_REQ', tc: number}, check)], {kind: 'challenge'}],
      [[entry({status: 'UNTRACEABLE', tc: number}, check)], {kind: 'indeterminate', name: 'NoHistoryError'}],
      [[entry({status: 'PROCESSING', tc: number, hid: found.hid}, check), entry({status: 'CHLNG_REQ', hid: found.hid})], {kind: 'challenge'}],
      [[entry({...noInfo, inProgress: true}), entry(noInfo)], {kind: 'indeterminate', name: 'NoHistoryError'}],
      [[entry(null, check, 429)], {status: 429, retryAfterMs: 60_000}],
    ] as const) {
      await expect(setup(captured([...entries])).tracker.fetch(number)).rejects.toMatchObject(expected);
    }
    const {tracker} = setup(captured([entry({status: 'CHLNG_REQ', tc: 'OTHER123'}, check), entry({...noInfo, inProgress: true}), entry(found)]));
    await expect(tracker.fetch(number)).resolves.toMatchObject({current_stage: 'delivered'});
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('rejects wrong identities, redirected pages and missing or unreadable captures', async () => {
    for (const response of [
      captured([entry({...found, track: {...found.track, tc: 'OTHER123'}})]),
      captured([entry(found)], {url: 'https://postal.ninja/en'}),
      captured([entry(found)], {url: 'https://postal.ninja/en/track#/another-handle'}),
      captured([entry(found)], {url: `https://other.test/en/track#/${found.hid}`}),
      captured([entry(found)], {tier: 1}),
      captured([], {capturedResponses: undefined}),
      captured([{...entry(found), body: null, error: 'unreadable'}]),
      captured([{...entry(found), truncated: true}]),
    ]) await expect(setup(response).tracker.fetch(number)).rejects.toThrow();
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });

  it('accepts the bound normal results page and selects full history over the widget summary', async () => {
    const compact = {...found, track: {...found.track, events: undefined, firstEv: found.track.events[0], lastEv: found.track.events.at(-1)}};
    const {tracker} = setup(captured([entry(compact), entry(found)], {url: `https://postal.ninja/en/track#/${found.hid}`}));
    const result = await tracker.fetch(number);
    expect(result.events).toEqual(parsePostalNinjaResponse(found, number).events);
    await expect(setup(captured([entry(compact)])).tracker.fetch(number)).rejects.toMatchObject({kind: 'indeterminate'});
  });

  it('reads a capture that ends while Postal Ninja still searches, with no scan shown, as no history yet', async () => {
    const searching = {...found, inProgress: true, track: {...found.track, state: 'NO_INFO', events: undefined}};
    const submitted = entry({status: 'PROCESSING', tc: number, hid: found.hid}, check);
    for (const entries of [[submitted], [submitted, entry(searching)]]) {
      await expect(setup(captured(entries)).tracker.fetch(number))
        .rejects.toMatchObject({name: 'NoHistoryError', kind: 'indeterminate', reason: 'still_searching'});
    }
    // A scan shown, a completed reply or another number's search is a capture that failed.
    const compact = {...found, track: {...found.track, events: undefined, lastEv: found.track.events.at(-1)}};
    for (const entries of [
      [submitted, entry({...compact, inProgress: true})],
      [submitted, entry(compact)],
      [entry({status: 'PROCESSING', tc: 'OTHER123', hid: 'other'}, check)],
    ]) {
      await expect(setup(captured(entries)).tracker.fetch(number))
        .rejects.toMatchObject({name: 'TrackingCaptureError', reason: 'history_missing'});
    }
  });
});

describe('Postal Ninja widget lookup', () => {
  it('submits the official embedded widget and reads its own tracking response', async () => {
    vi.mocked(scrapeUniversalPage).mockResolvedValueOnce({ events: [], status: 'delivered' });
    await expect(new PostalNinjaTracker({ executablePath: '/test/chromium' }).fetch(number)).resolves.toMatchObject({ status: 'delivered' });
    expect(scrapeUniversalPage).toHaveBeenCalledWith(
      expect.objectContaining({ executablePath: '/test/chromium', timeoutMs: expect.any(Number) }),
      expect.objectContaining({ name: 'Postal Ninja', url: 'https://postal.ninja/en/tools', responseUrl: 'https://postal.ninja/track/get' }),
      expect.any(Function),
    );
  });

  it('ends the widget lookup when the caller cancels', async () => {
    vi.mocked(scrapeUniversalPage).mockImplementationOnce(({ signal }) => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const lookup = new PostalNinjaTracker({ executablePath: '/test/chromium' }).fetch(number, undefined, null, controller.signal);
    await vi.waitFor(() => expect(scrapeUniversalPage).toHaveBeenCalledOnce());
    controller.abort(new Error('caller cancelled'));
    await expect(lookup).rejects.toThrow('caller cancelled');
  });

  it('validates the number and the budget before starting a browser', async () => {
    await expect(new PostalNinjaTracker().fetch('https://localhost')).rejects.toThrow('Invalid tracking number');
    await expect(new PostalNinjaTracker({ timeoutMs: Infinity }).fetch(number)).rejects.toThrow('timeout');
    expect(scrapeUniversalPage).not.toHaveBeenCalled();
  });
});

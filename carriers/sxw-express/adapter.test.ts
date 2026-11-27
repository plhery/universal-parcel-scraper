import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter, SxwTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { SXW, SXW_ORIGIN } from './parser.js';
import { statusMap, sxwEnglish } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'SXW999999999980';
const UNKNOWN = 'SXW999999999981';
const GOFO_NUMBER = 'GFUS99999999999980';
const READ_AT = Date.parse('2026-11-14T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shared = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

it('maps the inward mail centre automation scan as onward transit', () => {
  const wording = 'Inward MC - Automation Acceptance';
  const payload = JSON.parse(own('track.json'));
  const shipment = payload[0].data[0];
  shipment.trackDetails[0].track_content = wording;
  expect(parseHualeiTrack(payload, NUMBER, SXW, READ_AT)?.events?.find((event) => event.description === wording))
    .toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
});

it('maps the processing and unloading it copies from DHL in Germany as onward transit', () => {
  for (const wording of ['The shipment has been processed in the parcel center of origin', 'Unloaded from movement / tour vehicle']) {
    expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe('in_transit');
  }
});

it('keeps a parcel in transit when the delivering partner\'s warehouse takes it in', () => {
  for (const wording of ['Arrived At Warehouse', 'Arrived at warehouse']) {
    expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe('in_transit');
  }
});

it('reads the last-mile carrier\'s locker token as the parcel waiting for collection, not delivered', () => {
  expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'DELIVERED_TO_LOCKER' }))
    .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
});

it('maps the rows it copies from J&T Express Mexico, whatever their towns, sites, courier and phone', () => {
  for (const [wording, stage] of [
    ['【Villa Dos】【CLC-Norte.pdv】?Recolección exitosa!. El mensajero de J&T asignado OTRO.pcp recolectó tu envío. Para mayor información, comunícate al: 5500000000', 'in_transit'],
    ['【Villa Dos】Tu envío ha salido de【CLC-Norte.pdv】con destino a【MEXICO.sc】', 'in_transit'],
    ['【Villa Uno】Tu envío ha llegado a【MEXICO.sc】', 'in_transit'],
    ['【Villa Uno】【SITE-Sur.pdv】El mensajero de J&T Express OTRO1-DPA.pcp está en camino a tu domicilio. Si requieres mayor información, contáctanos al 5500000000', 'out_for_delivery'],
  ] as const) {
    expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(stage);
  }
});

describe('SXW Express numbers', () => {
  it('takes the universal providers’ names for the forwarder', () => {
    for (const name of ['SXW', 'SXW Wuliu', 'SXW Express', '胜兴旺', '深圳胜兴旺供应链管理有限公司']) {
      expect(carrierIdFromName(name), name).toBe('sxw-express');
    }
  });

  it('claims its own SXW waybills whole, and nothing shorter or longer', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'sxw-express', confidence: 'high', candidates: ['sxw-express'] });
    for (const number of ['SXW99999999998', 'SXW9999999999800', 'SXV999999999980']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('sxw-express');
    }
  });
});

describe('SXW Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number and names GOFO’s number for the last leg', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
      const result = await new SxwTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      expect(String(fetcher.mock.calls[0]![0])).toBe(`${SXW_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(result).toMatchObject({
        current_stage: 'in_transit', current_stage_source: 'carrier_map', destination_country: 'US',
        delivery_carrier: 'gofo', delivery_tracking_number: GOFO_NUMBER,
      });
      expect(result.events).toHaveLength(10);
      expect(result.events?.every((event) => event.stage)).toBe(true);
      expect(result.events?.at(-1)).toMatchObject({ stage: 'registered' });
      expect(JSON.stringify(result)).not.toContain('REF-0000-0001');
    } finally {
      vi.useRealTimers();
    }
  });

  it('names GOFO for its own number under a channel that names GOFO or no other carrier, whatever the destination', () => {
    // A synthetic record: SXW's number as the tracking number, GOFO's as the channel's transfer number.
    const record = (fields: Record<string, string>) => {
      const payload = JSON.parse(own('track.json'));
      Object.assign(payload[0].data[0], { trackingNumber: NUMBER, business_channeltransfercode: GOFO_NUMBER, ...fields });
      return parseHualeiTrack(payload, NUMBER, SXW, READ_AT)!;
    };
    for (const channel of ['', 'GOFO', 'GOFO Express', 'GOFO美国专线', '美国专线', 'US Line', 'SXW-US']) {
      expect(record({ channel_name: channel }), channel).toMatchObject({ delivery_carrier: 'gofo', delivery_tracking_number: GOFO_NUMBER });
    }
    expect(record({ consigneeCountry: 'DE' })).toMatchObject({ delivery_carrier: 'gofo', delivery_tracking_number: GOFO_NUMBER });
    // A channel naming another carrier, by the platform's table or a catalog name in its words, leaves the hand-off open.
    for (const channel of ['UPS', 'UPS红单', 'USPS Ground', 'Swiss Post', '瑞士邮政', 'China Post US Line']) {
      expect(record({ channel_name: channel }).delivery_carrier, channel).toBeUndefined();
    }
    // A number of another shape is no GOFO hand-off under any channel.
    expect(record({ channel_name: 'GOFO', business_channeltransfercode: '9400000000000000000000' }).delivery_carrier).toBeUndefined();
  });

  it('keeps the wall clock of the rows from the destination, from the first one placed abroad', () => {
    // A synthetic record shaped like a parcel to the UK: SXW copies the partner's rows and Royal Mail's acceptance on UK time.
    const payload = JSON.parse(own('track.json'));
    const row = (date: string, written: string, content: string, location: string) =>
      ({ ...payload[0].data[0].trackDetails[0], track_date: date, track_createdate: written, track_content: content, track_location: location });
    Object.assign(payload[0].data[0], { consigneeCountry: 'GB', trackDetails: [
      row('2026-11-18 04:04:37', '2026-11-18 13:32:27', 'Royal Mail Acceptance', 'EXAMPLE MC'),
      row('2026-11-17 11:22:38', '2026-11-17 19:44:33', 'Departed from facility', 'EXAMPLETOWN, EXAMPLE, GB'),
      row('2026-11-16 20:25:00', '2026-11-17 06:50:37', 'International flight has arrived', 'GB'),
      row('2026-11-16 13:51:00', '2026-11-16 15:17:12', 'International flight has departed', ''),
      row('2026-11-15 16:01:59', '2026-11-15 17:48:42', 'Arrived at the origin international hub', 'EXAMPLECITY, CN'),
    ] });
    const result = parseHualeiTrack(payload, NUMBER, SXW, Date.parse('2026-11-18T12:00:00Z'))!;
    expect(result.events?.map((event) => [event.time, event.local_time])).toEqual([
      [undefined, '2026-11-18T04:04:37'], [undefined, '2026-11-17T11:22:38'], [undefined, '2026-11-16T20:25:00'],
      ['2026-11-16T13:51:00+08:00', undefined], ['2026-11-15T16:01:59+08:00', undefined],
    ]);
    // Places then date them on the UK's clock, the acceptance by the leg it is on.
    expect(dateLocalClocks('sxw-express', result).events?.slice(0, 3).map((event) => event.time)).toEqual([
      '2026-11-18T04:04:37+00:00', '2026-11-17T11:22:38+00:00', '2026-11-16T20:25:00+00:00',
    ]);
  });

  it('keeps the wall clock of Australia Post\'s suburb-and-state rows and of a landing named by its airport', () => {
    // A synthetic record shaped like a parcel to Australia: no place there ends in a country code.
    const payload = JSON.parse(own('track.json'));
    const row = (date: string, written: string, content: string, location: string) =>
      ({ ...payload[0].data[0].trackDetails[0], track_date: date, track_createdate: written, track_content: content, track_location: location });
    Object.assign(payload[0].data[0], { consigneeCountry: 'AU', trackDetails: [
      // Written at 14:20 on Beijing's clock: 14:40 there would be a row written before it happened.
      row('2026-11-20 14:40:00', '2026-11-20 14:20:00', 'NOA-Notification of arrival from GHA', 'MEL'),
      row('2026-11-20 10:30:00', '2026-11-20 12:10:00', 'International flight has arrived', 'MEL'),
      row('2026-11-18 21:15:00', '2026-11-20 12:10:00', 'Shipping information approved by Australia Post', 'DANDENONG SOUTH VIC'),
      row('2026-11-18 20:40:00', '2026-11-19 11:10:00', 'International flight has departed', 'China'),
      row('2026-11-17 05:40:00', '2026-11-17 06:30:00', 'Arrived at the origin international hub', 'PVG'),
    ] });
    const result = parseHualeiTrack(payload, NUMBER, SXW, Date.parse('2026-11-20T12:00:00Z'))!;
    expect(result.events?.map((event) => [event.time, event.local_time])).toEqual([
      [undefined, '2026-11-20T14:40:00'], [undefined, '2026-11-20T10:30:00'], ['2026-11-18T21:15:00+11:00', '2026-11-18T21:15:00'],
      ['2026-11-18T20:40:00+08:00', undefined], ['2026-11-17T05:40:00+08:00', undefined],
    ]);
    // Places date the landing on Melbourne's clock; Australia Post's row is on the east coast's.
    expect(result.events?.[2]).toMatchObject({ time_zone: 'Australia/Sydney', time_zone_basis: 'destination', stage: 'registered' });
    expect(dateLocalClocks('sxw-express', result).events?.slice(0, 3).map((event) => event.time))
      .toEqual(['2026-11-20T14:40:00+11:00', '2026-11-20T10:30:00+11:00', '2026-11-18T21:15:00+11:00']);

    // To Brisbane: Australia Post's own row is at 20:15 there, which SXW copies at 21:15 on the east
    // coast's summer clock; the landing keeps Brisbane's clock.
    payload[0].data[0].trackDetails[0].track_location = 'BNE';
    payload[0].data[0].trackDetails[1].track_location = 'BNE';
    payload[0].data[0].trackDetails[2].track_location = 'UNDERWOOD QLD';
    const brisbane = dateLocalClocks('sxw-express', parseHualeiTrack(payload, NUMBER, SXW, Date.parse('2026-11-20T12:00:00Z'))!);
    expect(brisbane.events?.slice(0, 3).map((event) => [event.time, event.time_zone])).toEqual([
      ['2026-11-20T14:40:00+10:00', 'Australia/Brisbane'], ['2026-11-20T10:30:00+10:00', 'Australia/Brisbane'],
      ['2026-11-18T21:15:00+11:00', 'Australia/Sydney'],
    ]);
    // A suburb and state the gazetteer does not place in Australia is no row abroad.
    payload[0].data[0].trackDetails[2].track_location = 'EXAMPLE NOWHERE VIC';
    payload[0].data[0].trackDetails.splice(0, 2);
    expect(parseHualeiTrack(payload, NUMBER, SXW, Date.parse('2026-11-20T12:00:00Z'))!.events?.[0]?.time).toBe('2026-11-18T21:15:00+08:00');
  });

  it("dates GOFO's rows on GOFO's clock, which SXW takes for Eastern time", () => {
    // A synthetic record shaped like a parcel GOFO delivers: SXW's copy of each GOFO scan is three hours before GOFO's own.
    const payload = JSON.parse(own('track.json'));
    const row = (date: string, written: string, content: string, location: string) =>
      ({ ...payload[0].data[0].trackDetails[0], track_date: date, track_createdate: written, track_content: content, track_location: location });
    Object.assign(payload[0].data[0], { trackDetails: [
      row('2026-11-21 09:40:00', '2026-11-21 23:00:00', 'Loaded on Vehicle', 'Charlotte'),
      row('2026-11-20 22:10:00', '2026-11-21 08:00:00', 'Arrived at GOFO Regional Hub', 'Charlotte'),
      row('2026-11-19 23:20:00', '2026-11-20 11:30:00', 'Departed GOFO Regional Hub', 'Carteret'),
      row('2026-11-19 22:50:00', '2026-11-20 11:30:00', 'Loaded on Vehicle', ''),
      row('2026-11-19 21:30:00', '2026-11-20 11:30:00', 'Arrived at GOFO Regional Hub', 'Carteret'),
      row('2026-11-18 07:30:00', '2026-11-18 10:40:00', 'Parcel arrives at Airport, Parcel Arrival', ''),
    ] });
    const result = parseHualeiTrack(payload, NUMBER, SXW, Date.parse('2026-11-22T00:00:00Z'))!;
    // 21:30 in Beijing is 08:30 in New York, GOFO's 08:30 in Los Angeles: 11:30 at Carteret. A row with no place stays on Pacific time.
    expect(result.events?.map((event) => [event.time, event.time_zone])).toEqual([
      ['2026-11-20T23:40:00-05:00', 'America/New_York'], ['2026-11-20T12:10:00-05:00', 'America/New_York'],
      ['2026-11-19T13:20:00-05:00', 'America/New_York'], ['2026-11-19T09:50:00-08:00', 'America/Los_Angeles'],
      ['2026-11-19T11:30:00-05:00', 'America/New_York'], ['2026-11-18T07:30:00+08:00', undefined],
    ]);
    expect(result.events?.[4]).toMatchObject({ local_time: '2026-11-19T11:30:00', time_zone_basis: 'carrier' });
  });

  it('reads the rows after the shipper took the parcel back as the parcel sent again', () => {
    const payload = JSON.parse(own('track.json'));
    const row = (date: string, content: string, location: string) =>
      ({ ...payload[0].data[0].trackDetails[0], track_date: date, track_createdate: date, track_content: content, track_location: location });
    Object.assign(payload[0].data[0], { consigneeCountry: 'FI', trackDetails: [
      row('2026-11-12 09:00:00', 'Arrived at sort facility', 'EXAMPLETOWN, EXAMPLE, FI'),
      row('2026-11-11 14:00:00', 'International flight has departed', ''),
      row('2026-11-11 10:00:00', 'Arrived at origin facility', 'Mainland China, CN'),
      row('2026-11-10 10:00:00', 'Returned parcel has been recieved by shipper', 'Mainland China, CN'),
      row('2026-11-09 10:00:00', 'Arrived at origin facility', 'Mainland China, CN'),
    ] });
    const result = parseHualeiTrack(payload, NUMBER, SXW, Date.parse('2026-11-13T00:00:00Z'))!;
    // Held back and sent again: an exception, so that no return holds over the journey after it.
    expect(result.events?.map((event) => event.stage)).toEqual(['in_transit', 'in_transit', 'in_transit', 'exception', 'in_transit']);
    expect(result.current_stage).toBe('in_transit');
    // While nothing follows it, the shipper has the parcel back.
    Object.assign(payload[0].data[0], { trackDetails: payload[0].data[0].trackDetails.slice(3) });
    const back = parseHualeiTrack(payload, NUMBER, SXW, Date.parse('2026-11-13T00:00:00Z'))!;
    expect(back.events?.map((event) => event.stage)).toEqual(['returned', 'in_transit']);
    expect(back.current_stage).toBe('returned');
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(shared('no-track.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${SXW_ORIGIN}/trackIndex.htm`);
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    // A row with a mark and no words moves nothing; one with words stays for review.
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: '.' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringMatching(/without words/) });
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Sample wording' }).kind).toBe('unknown');
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Parcel picked up' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Parcel is leaving Airport, Parcel Leaving Port' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    // Another line's rows: its first scan is the collection from SXW, after the parcel left SXW's operation centre.
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Item has been collected' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Item outbound in sorting center.' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    // USPS's rows on the line into the United States: its partner's pickup and its own acceptance come after SXW accepted the parcel.
    for (const description of ['Picked up by Shipping Partner', 'Accepted at USPS Facility']) {
      expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description }), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // The import release ends the customs stage, and a relabelling under another number moves the parcel on.
    for (const description of ['customs released - import', 'change tracking number and relabel']) {
      expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description }), description).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    // The platform's Chinese rows show the English its other tenants give them, which the map reads too.
    expect(sxwEnglish(null, normalizeStatusWording('到达收货点'))).toBe('Arrived at the receiving point');
    expect(statusMapAnswer({ carrier: 'sxw-express', providerCode: null, description: 'Goods leave the operation center' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});

it.each([
  'Item Flight departure', 'Initial landing', 'Connecting flights flight takeoff', 'Item Flight landing',
  'HKG-Notification of arrival from SZX', 'The goods have been picked up abroad', 'Released From Import Customs',
  'Shipment in transit to DHL',
])('reads the flight, arrival, import and handover scan %s as transit', (wording) => {
  const payload = JSON.parse(own('track.json'));
  const shipment = payload[0].data[0];
  shipment.trackDetails[0].track_content = wording;
  expect(parseHualeiTrack(payload, NUMBER, SXW, READ_AT)?.events?.find((event) => event.description === wording))
    .toMatchObject({ stage: 'in_transit', stage_source: 'carrier_map' });
});

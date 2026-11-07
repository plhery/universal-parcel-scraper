import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import { adapter, HuayaTracker } from './adapter.js';
import { HUAYA_ORIGIN, parseHuayaPage, parseHuayaTrack } from './parser.js';
import { ENTRIES, statusMap } from './status.js';

const NUMBER = 'HYYT999999999980GZ';
const UNKNOWN = 'HYYT990000000009GZ';
// A day after the hand-over row, on Beijing's clock.
const READ_AT = Date.parse('2026-03-15T08:00:00Z');
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Huaya Express numbers', () => {
  it('names Huaya Express for HYYT, twelve digits and GZ only', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'huaya-express', confidence: 'high' });
    for (const other of ['HYYT99000000001GZ', 'HYYT9900000000001GZ', 'HYYT990000000001SZ', 'HYT990000000001GZ', 'HYYT990000000001GZX']) {
      const match = detectCarrierMatch(other);
      expect([match.carrier, ...(match.candidates ?? [])], other).not.toContain('huaya-express');
    }
  });

  it('reads the number out of a link to its tracker', () => {
    expect(parseTrackingInput(`http://193.112.176.17:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'huaya-express' });
  });

  it('takes 17TRACK’s name for the forwarder', () => {
    for (const name of ['GZHY', 'Huaya Express', '华亚运通']) expect(carrierIdFromName(name), name).toBe('huaya-express');
  });
});

describe('Huaya Express tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new HuayaTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({ destination_country: 'GB' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${HUAYA_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(HUAYA_ORIGIN).toBe('http://193.112.176.17:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'huaya-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the rows on Beijing time with the stages its map gives, without the parties', () => {
    const result = parseHuayaTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'It has been handed over to the service provider.',
      last_update: '2026-03-14T15:26:01+08:00', service_name: 'Synthetic UK Line', destination_country: 'GB',
    });
    expect(result.events!.map(({ time, description, stage }) => ({ time, description, stage }))).toEqual([
      { time: '2026-03-14T15:26:01+08:00', description: 'It has been handed over to the service provider.', stage: 'in_transit' },
      { time: '2026-03-05T15:55:50+08:00', description: 'Customs import clearance completed, awaiting pickup by local carrier', stage: 'in_transit' },
      { time: '2026-03-05T09:23:26+08:00', description: 'Package arrived at destination country', stage: 'in_transit' },
      { time: '2026-03-03T17:04:14+08:00', description: 'Package in transit to destination country', stage: 'in_transit' },
      { time: '2026-03-03T04:14:26+08:00', description: 'Package handed over to airline', stage: 'in_transit' },
      { time: '2026-03-02T03:37:14+08:00', description: 'Customs export clearance completed', stage: 'in_transit' },
      { time: '2026-03-01T03:08:26+08:00', description: 'Package departed from the warehouse', stage: 'in_transit' },
      { time: '2026-03-01T02:41:26+08:00', description: 'Package received & scanned at warehouse', stage: 'accepted' },
    ]);
    expect(result.delivery_carrier).toBeUndefined();
    const text = JSON.stringify(result);
    for (const value of ['Synthetic Recipient', 'Example Street', 'HY-TEST-001', 'HYTEST0000000000001']) expect(text, value).not.toContain(value);
  });

  it('reads a label row written at "US, SYSTEM, SYSTEM", that place repeated in its wording, with no place', () => {
    const reply = structuredClone(fixture('track')) as [{ data: [{ trackDetails: Record<string, string>[] }] }];
    const rows = reply[0].data[0].trackDetails;
    rows.push({ ...rows.at(-1)!, track_date: '2026-02-27 08:45:25', track_createdate: '2026-02-28 14:40:06',
      track_content: 'US, SYSTEM, SYSTEM, Shipping Label Created', track_location: 'US, SYSTEM, SYSTEM' });
    rows[4]!.track_content = 'GUANGZHOU, Package handed over to airline';
    const events = parseHuayaTrack(reply, NUMBER, READ_AT)!.events!;
    expect(events.at(-1)).toMatchObject({ time: '2026-02-27T08:45:25+08:00', description: 'Shipping Label Created',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(events.at(-1)!.location).toBeUndefined();
    expect(events[4]).toMatchObject({ description: 'Package handed over to airline', location: 'GUANGZHOU', stage: 'in_transit' });
    for (const wording of ['GUANGZHOU', 'GUANGZHOU,', 'GUANGZHOUX, Package handed over to airline']) {
      rows[4]!.track_content = wording;
      expect(parseHuayaTrack(reply, NUMBER, READ_AT)!.events![4]!.description, wording).toBe(wording.replace(/,$/, ''));
    }
  });

  it('lets a label row stored with its place repeated, or at "US, SYSTEM, SYSTEM", be taken over once read without it', () => {
    const policy = sameInstantIdentityPolicy('huaya-express', { supportsScanMatching: true })!;
    const stored = { stage: 'registered', description: 'US, SYSTEM, SYSTEM, Shipping Label Created', location: 'US, SYSTEM, SYSTEM', providerCode: '' };
    const incoming = { ...stored, description: 'Shipping Label Created', location: '' };
    expect(policy.matches?.(incoming, stored)).toBe(true);
    expect(policy.matches?.(incoming, { ...stored, description: 'Shipping Label Created' })).toBe(true);
    const handed = { stage: 'in_transit', description: 'GUANGZHOU, Package handed over to airline', location: 'GUANGZHOU', providerCode: '' };
    expect(policy.matches?.({ ...handed, description: 'Package handed over to airline' }, handed)).toBe(true);
    for (const different of [
      { ...incoming, description: 'Package handed over to airline' },
      { ...incoming, location: 'GUANGZHOU' },
    ]) expect(policy.matches?.(different, stored), JSON.stringify(different)).toBe(false);
    expect(policy.matches?.({ ...handed, description: 'Package handed over to airline', location: '' }, handed)).toBe(false);
    expect(policy.matches?.({ ...handed, description: 'Package handed over to airline', location: 'SHENZHEN' }, handed)).toBe(false);
  });

  it('dates the rows it copies from DHL on DHL’s clock and reads the way back after a return as returned', () => {
    const reply = structuredClone(fixture('track')) as [{ data: [{ consigneeCountry: string; trackDetails: Record<string, string>[] }] }];
    const record = reply[0].data[0];
    const template = record.trackDetails.at(-1)!;
    // Newest first, as the tracker lists them, each with the platform's Beijing time it was written at.
    const row = (date: string, created: string, content: string, kind = '') =>
      ({ ...template, track_date: date, track_createdate: created, track_content: content, track_location: '', track_kind: kind });
    record.consigneeCountry = 'DE';
    record.trackDetails = [
      row('2026-11-04 10:00:00', '2026-11-04 18:33:03', 'The shipment has been sent directly from the parcel center to the business customer.'),
      row('2026-11-04 04:35:00', '2026-11-04 14:33:02', 'The shipment arrived in the region of recipient and will be transported to the delivery base in the next step.'),
      row('2026-11-03 20:37:00', '2026-11-04 06:33:03', 'The shipment has been processed in the parcel center of origin'),
      row('2026-11-02 13:42:00', '2026-11-02 22:33:02', 'Unfortunately delivery of the shipment was not possible. The shipment is returned to the sender.'),
      row('2026-11-02 13:42:00', '2026-11-02 22:33:02', 'The recipient could not be found at the address on the shipment.'),
      row('2026-11-02 09:55:00', '2026-11-02 18:33:03', 'The shipment has been loaded onto the delivery vehicle.'),
      row('2026-10-28 11:03:00', '2026-10-29 21:48:27', '已交仓'),
      row('2026-10-23 22:57:00', '2026-10-28 16:59:18', '清关完成'),
      row('2026-10-22 15:19:00', '2026-10-28 16:59:18', '航班落地，清关中'),
      row('2026-10-22 10:05:00', '2026-10-28 16:59:18', '航班起飞，预计航班落地时间(10.22)'),
      row('2026-10-18 18:37:00', '2026-10-19 02:33:00', 'The shipment is in transit to DHL'),
      row('2026-10-18 01:14:00', '2026-10-18 10:03:04', 'The instruction data for this shipment have been provided by the sender to DHL electronically'),
      row('2026-10-17 23:47:00', '2026-10-17 23:47:42', '到达收货点', 'ARRIVAL'),
    ];
    const result = parseHuayaTrack(reply, NUMBER, Date.parse('2026-11-05T00:00:00Z'))!;
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned', last_update: '2026-11-04T10:00:00+01:00' });
    expect(result.events!.map(({ time, stage }) => [time, stage])).toEqual([
      // DHL's rows on its German wall clock: each was written at the platform's next 4-hourly
      // poll, which Beijing time would put seven to ten hours later.
      ['2026-11-04T10:00:00+01:00', 'returned'],
      ['2026-11-04T04:35:00+01:00', 'returned'],
      ['2026-11-03T20:37:00+01:00', 'returned'],
      ['2026-11-02T13:42:00+01:00', 'returned'],
      ['2026-11-02T13:42:00+01:00', 'failed_attempt'],
      ['2026-11-02T09:55:00+01:00', 'out_for_delivery'],
      // Huaya's own rows on the platform's Beijing clock.
      ['2026-10-28T11:03:00+08:00', 'in_transit'],
      ['2026-10-23T22:57:00+08:00', 'in_transit'],
      ['2026-10-22T15:19:00+08:00', 'customs'],
      ['2026-10-22T10:05:00+08:00', 'in_transit'],
      ['2026-10-18T18:37:00+02:00', 'in_transit'],
      ['2026-10-18T01:14:00+02:00', 'registered'],
      ['2026-10-17T23:47:00+08:00', 'accepted'],
    ]);
    expect(result.events!.filter((event) => event.time_zone).map((event) => event.time_zone_basis))
      .toEqual(['destination', 'destination', 'carrier', 'destination', 'destination', 'destination', 'carrier', 'carrier']);
    // Without a return the delivery is the recipient's.
    record.trackDetails.splice(0, 4);
    record.trackDetails.unshift(row('2026-11-02 13:42:00', '2026-11-02 22:33:02', 'The shipment has been sent directly from the parcel center to the business customer.'));
    expect(parseHuayaTrack(reply, NUMBER, Date.parse('2026-11-05T00:00:00Z'))).toMatchObject({ current_stage: 'delivered' });
  });

  it('dates the US delivery partner’s rows on the wall clock of the town each names', () => {
    const reply = structuredClone(fixture('track')) as [{ data: [{ consigneeCountry: string; trackDetails: Record<string, string>[] }] }];
    const record = reply[0].data[0];
    const template = record.trackDetails.at(-1)!;
    const row = (date: string, created: string, content: string, location: string) =>
      ({ ...template, track_date: date, track_createdate: created, track_content: content, track_location: location, track_kind: '' });
    record.consigneeCountry = 'US';
    // Newest first. Each was written at the platform's next 4-hourly poll after its American time; on
    // Beijing time it would have waited 14 to 17 hours, and the round would start the evening before.
    record.trackDetails = [
      row('2026-12-04 08:42:39', '2026-12-04 22:43:08', 'Out for Delivery', 'US, EDISON, EWR Warehouse'),
      row('2026-12-04 00:49:20', '2026-12-04 14:43:05', 'Arrived At Warehouse', 'US, EDISON, EWR Warehouse'),
      row('2026-12-03 23:11:42', '2026-12-04 14:43:05', 'Departed Destination Hub', 'US, CARTERET, EWR HUB'),
      row('2026-12-03 13:41:59', '2026-12-04 06:43:03', 'Arrived at Destination Hub', 'US, CARTERET, EWR HUB'),
      row('2026-12-02 20:31:48', '2026-12-03 10:42:05', 'Departed Origin Hub', 'US, BENSENVILLE, ORD HUB'),
      row('2026-12-01 22:36:52', '2026-12-02 14:42:02', 'Arrived at Origin Hub', 'US, BENSENVILLE, ORD HUB'),
      row('2026-11-23 08:45:25', '2026-11-26 14:40:06', 'US, SYSTEM, SYSTEM, Shipping Label Created', 'US, SYSTEM, SYSTEM'),
    ];
    const result = dateLocalClocks('huaya-express', parseHuayaTrack(reply, NUMBER, Date.parse('2026-12-04T16:00:00Z'))!);
    expect(result).toMatchObject({ current_stage: 'out_for_delivery', last_update: '2026-12-04T08:42:39-05:00' });
    expect(result.events!.map(({ time, time_zone, time_zone_basis }) => [time, time_zone, time_zone_basis])).toEqual([
      ['2026-12-04T08:42:39-05:00', 'America/New_York', 'place'],
      ['2026-12-04T00:49:20-05:00', 'America/New_York', 'place'],
      ['2026-12-03T23:11:42-05:00', 'America/New_York', 'place'],
      ['2026-12-03T13:41:59-05:00', 'America/New_York', 'place'],
      ['2026-12-02T20:31:48-06:00', 'America/Chicago', 'place'],
      ['2026-12-01T22:36:52-06:00', 'America/Chicago', 'place'],
      // The label row names no town and stays on the platform's clock.
      ['2026-11-23T08:45:25+08:00', undefined, undefined],
    ]);
    for (const event of result.events!.slice(0, 6)) {
      const wait = Date.parse(event.written_at!) - Date.parse(event.time!);
      expect(wait > 0 && wait < 4.5 * 3_600_000, event.description).toBe(true);
    }
  });

  it('holds back a row dated after the lookup', () => {
    const result = parseHuayaTrack(fixture('track'), NUMBER, Date.parse('2026-03-10T00:00:00Z'))!;
    expect(result).toMatchObject({ last_status_text: 'Customs import clearance completed, awaiting pickup by local carrier' });
    expect(result.events).toHaveLength(7);
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${HUAYA_ORIGIN}/trackIndex.htm`);
    expect(() => parseHuayaPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists by wording alone, and the app reads the map', () => {
    for (const entry of ENTRIES) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'huaya-express', providerCode: null, description: 'Package received & scanned at warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'huaya-express', providerCode: 'ARRIVAL', description: '到达收货点' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'huaya-express', providerCode: null, description: '合成的记录' })).toEqual({ kind: 'unknown' });
  });
});

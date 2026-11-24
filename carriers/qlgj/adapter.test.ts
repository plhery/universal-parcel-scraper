import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter, QlgjTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { QLGJ, QLGJ_ORIGIN } from './parser.js';
import { qlgjEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic sample in numbers.json, which `track.json` answers.
const NUMBER = 'QL0000000271828YQ';
const UNKNOWN = 'QL0000000000000YQ';
const READ_AT = Date.parse('2026-05-25T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shared = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Qilin International numbers', () => {
  it('takes the universal providers’ names for the forwarder', () => {
    for (const name of ['QLGJ', 'Qi Lin Guo ji', '琪林国际', '广州市琪林国际物流有限公司']) expect(carrierIdFromName(name), name).toBe('qlgj');
  });

  it('claims its QL…YQ numbers whole, and nothing shorter or longer', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'qlgj', confidence: 'high' });
    for (const number of [NUMBER.slice(0, -3) + 'YQ', `${NUMBER.slice(0, -2)}0YQ`, `QA${NUMBER.slice(2)}`, `${NUMBER.slice(0, -2)}YX`]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('qlgj');
      expect(detectCarrierMatch(number).carrier, number).not.toBe('qlgj');
    }
  });
});

describe('Qilin International tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number and names DHL’s number for the last leg', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
      const result = await new QlgjTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      expect(String(fetcher.mock.calls[0]![0])).toBe(`${QLGJ_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(result).toMatchObject({
        current_stage: 'in_transit', current_stage_source: 'carrier_map', destination_country: 'FR',
        delivery_carrier: 'dhl', delivery_tracking_number: 'CP123456785DE', service_name: 'Europe DHL-F Economy',
      });
      // The custom-track row the line writes ahead is held back as a step, as on every tenant.
      expect(result.events).toHaveLength(5);
      expect(result.planned_events).toEqual([{ time: '2026-05-15T09:46:57+08:00', description: 'exit customs clearance complete', stage: 'in_transit' }]);
      expect(result.events?.every((event) => event.stage)).toBe(true);
      const row = (description: string) => result.events?.find((event) => event.description === description);
      // Rows in China, placed in Latin letters or nowhere, on the platform's Beijing clock; the arrival abroad keeps its wall clock.
      expect(row('Inbound in sorting center')).toMatchObject({ stage: 'accepted', time: '2026-05-14T13:41:27+08:00' });
      expect(row('Wait for a flight')).toMatchObject({ time: '2026-05-19T18:07:35+08:00' });
      expect(row('Handed to the airline, flight departed')).toMatchObject({ time: '2026-05-20T11:09:21+08:00' });
      expect(row('Flight arrived')).toMatchObject({ local_time: '2026-05-21T14:44:10' });
      expect(row('Flight arrived')).not.toHaveProperty('time');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dates the rows it copies from DHL, placed or not, on DHL’s clock in Germany', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const payload = JSON.parse(own('track.json'));
      const record = payload[0].data[0];
      const copy = (id: string, date: string, written: string, content: string, location = '') => ({
        ...record.trackDetails[0], track_id: id, track_date: date, track_createdate: written, track_content: content, track_location: location,
      });
      record.trackDetails.unshift(
        copy('20000010', '2026-05-24 10:19:00', '2026-05-24 18:02:00', 'The international shipment has been processed in the parcel center of origin'),
        copy('20000009', '2026-05-23 22:02:00', '2026-05-24 06:10:00', '抵达德国，已交服务商', 'FRA'),
      );
      record.trackDetails.push(copy('20000001', '2026-05-14 12:15:00', '2026-05-14 19:40:00',
        'The instruction data for this shipment have been provided by the sender to DHL electronically'));
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(payload)));
      const result = await new QlgjTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER);
      const row = (description: string) => result.events?.find((event) => event.description === description);
      // Read on Beijing's clock, these would come seven hours before DHL's own rows for the same scans.
      expect(row('The international shipment has been processed in the parcel center of origin')).toMatchObject({
        stage: 'in_transit', stage_source: 'carrier_map', time: '2026-05-24T10:19:00+02:00', time_zone: 'Europe/Berlin', time_zone_basis: 'carrier',
      });
      expect(row('The instruction data for this shipment have been provided by the sender to DHL electronically')).toMatchObject({
        stage: 'registered', stage_source: 'carrier_map', time: '2026-05-14T12:15:00+02:00',
      });
      // The hand-over to DHL, at the airport it names, keeps its wall clock, and shows in English.
      expect(row('Arrived in Germany, handed to the delivering carrier')).toMatchObject({ stage: 'in_transit', local_time: '2026-05-23T22:02:00' });
      expect(result.last_update).toBe('2026-05-24T10:19:00+02:00');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the hand-off open for a number no partner claims', () => {
    const payload = JSON.parse(own('track.json'));
    payload[0].data[0].trackingNumber = 'EM000000000CA';
    expect(parseHualeiTrack(payload, NUMBER, QLGJ, READ_AT)!.delivery_carrier).toBeUndefined();
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${QLGJ_ORIGIN}/trackIndex.htm`);
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'qlgj', providerCode: null, description: 'Inbound in sorting center' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'qlgj', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    // The booked flight's day and the airport it lands at are read as an ellipsis.
    for (const description of ['Estimated departure is March 5th', 'Estimated arrival date is March 22nd', 'Arrived at Sample Town Airport']) {
      expect(statusMapAnswer({ carrier: 'qlgj', providerCode: null, description })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    }
    expect(qlgjEnglish(null, normalizeStatusWording('航班已抵达'))).toBe('Flight arrived');
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter, FsqhTracker } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { FSQH, FSQH_ORIGIN } from './parser.js';
import { fsqhEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic sample in numbers.json, which `track.json` answers; `gb-line.json` answers another made-up number.
const NUMBER = 'QH000000271828FS';
const GB_NUMBER = 'QH000000314159FS';
const UNKNOWN = 'QH000000000000FS';
const READ_AT = Date.parse('2026-05-25T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const shared = (name: string) => readFileSync(new URL(`../gzyl/fixtures/${name}`, import.meta.url), 'utf8');
const reply = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Foshan Qianhe numbers', () => {
  it('takes the universal providers’ names for the forwarder', () => {
    for (const name of ['FSQH', 'Foshan Qianhe', '佛山乾和', '佛山乾和国际供应链有限公司']) expect(carrierIdFromName(name), name).toBe('fsqh');
  });

  it('offers its QH…FS numbers whole, before DHLink, which carries some of them, and nothing shorter or longer', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['fsqh', 'dhlink'], preferred: ['fsqh'] });
    for (const number of [NUMBER.slice(0, -1), `${NUMBER}0`, `QH0${NUMBER.slice(2)}`, `QA${NUMBER.slice(2)}`, `${NUMBER.slice(0, -2)}FX`]) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('fsqh');
    }
  });
});

describe('Foshan Qianhe tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number and names GOFO’s number for the last leg', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
      const result = await new FsqhTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase());
      expect(String(fetcher.mock.calls[0]![0])).toBe(`${FSQH_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(result).toMatchObject({
        current_stage: 'in_transit', current_stage_source: 'carrier_map', destination_country: 'US',
        delivery_carrier: 'gofo', delivery_tracking_number: 'GFUS01234567890102', service_name: 'US Line Small Parcel(Shoe Boxes)',
      });
      expect(result.events).toHaveLength(15);
      expect(result.events?.every((event) => event.stage)).toBe(true);
      const row = (description: string) => result.events?.find((event) => event.description === description);
      // Rows in China on the platform's Beijing clock; rows the line copies from Chicago keep their wall clock.
      expect(row('Package received and scanned at warehouse')).toMatchObject({ stage: 'accepted', time: '2026-05-13T19:07:22+08:00' });
      expect(row('Your item has left the East China warehouse')).toMatchObject({ time: '2026-05-17T10:08:36+08:00', location: '上海' });
      expect(row('Arrived at US IL Chicago O\'Hare International Airport')).toMatchObject({ local_time: '2026-05-19T03:10:00', location: 'Chicago' });
      expect(row('Arrived at US IL Chicago O\'Hare International Airport')).not.toHaveProperty('time');
      // GOFO's label on Pacific time, as other lines into the United States copy it.
      expect(row('Shipping Label Created')).toMatchObject({ stage: 'registered', time: '2026-05-13T03:22:48-07:00' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('names Royal Mail on the line to Britain and shows the line’s Chinese rows in English', () => {
    const result = parseHualeiTrack(JSON.parse(own('gb-line.json')), GB_NUMBER, FSQH, READ_AT)!;
    expect(result).toMatchObject({
      current_stage: 'in_transit', destination_country: 'GB', delivery_carrier: 'royal-mail', delivery_tracking_number: 'QP123456785GB',
      last_status_text: 'Flight departed, expected to land on 05.24', last_update: '2026-05-23T05:00:23+08:00',
    });
    expect(result.events?.map((event) => event.description)).toContain('Export customs clearance completed');
    expect(result.events?.every((event) => event.stage && event.time?.endsWith('+08:00'))).toBe(true);
  });

  it('leaves the hand-off open for a number no partner claims', () => {
    const payload = JSON.parse(own('track.json'));
    payload[0].data[0].business_channeltransfercode = 'EM000000000CA';
    expect(parseHualeiTrack(payload, NUMBER, FSQH, READ_AT)!.delivery_carrier).toBeUndefined();
  });

  it('settles the interface’s no-row answer with the page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${FSQH_ORIGIN}/trackIndex.htm`);
  });

  it('recognizes by the same lookup, since DHLink also answers some of its numbers', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(own('unknown.json')))
      .mockResolvedValueOnce(reply(shared('page-unknown.html').replaceAll('NOTFOUND000001', UNKNOWN)));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(reply(own('track.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('maps every row it has written, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMapAnswer({ carrier: 'fsqh', providerCode: null, description: 'Arrived at US CA Los Angeles International Airport' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'fsqh', providerCode: null, description: 'Package received and scanned at warehouse' }))
      .toEqual({ kind: 'mapped', stage: 'accepted' });
    expect(statusMapAnswer({ carrier: 'fsqh', providerCode: null, description: 'Votre colis est en transit sur nos plateformes logistiques.' }))
      .toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'fsqh', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    expect(fsqhEnglish(null, normalizeStatusWording('航班起飞，预计航班落地时间(12.03)'))).toBe('Flight departed, expected to land on 12.03');
    expect(fsqhEnglish(null, normalizeStatusWording('安排航班中'))).toBe('Arranging a flight');
    expect(statusMap.stage(null, normalizeStatusWording('航班落地，清关中'))).toBe('customs');
    expect(fsqhEnglish(null, normalizeStatusWording('已交仓'))).toBe('Handed to the warehouse');
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});

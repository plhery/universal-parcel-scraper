import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { parseHualeiPage, parseHualeiTrack } from '../gzyl/hualei.js';
import { adapter, AnhuaTracker } from './adapter.js';
import { ANHUA, ANHUA_ORIGIN, isAnhuaAustraliaPostRow, splitAnhuaRow } from './parser.js';
import { anhuaEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, Australia Post's article id, which `delivered.json` answers, and a made-up number
// the tracker does not know.
const NUMBER = '39BRK509054301000931502';
const UNKNOWN = '39ZZQ0000000017';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-27T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const unknownPage = () => readFileSync(new URL('../gzyl/fixtures/page-unknown.html', import.meta.url), 'utf8').replaceAll('NOTFOUND000001', UNKNOWN);
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const row = (content: string, code = '') => ({ clock: '2026-10-09 23:17:36', content, location: '', code });

describe('Anhua International numbers', () => {
  it('takes the forwarder’s names', () => {
    for (const name of ['Anhua International', 'Anhua International Supply Chain', '安华国际供应链', '广州安华国际供应链管理有限公司']) {
      expect(carrierIdFromName(name), name).toBe('anhua-international');
    }
  });

  it('claims no shape, since its numbers are Australia Post’s, and reads a link to its tracker', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('anhua-international');
    expect(parseTrackingInput(`http://www.ahgjgyl.com:8082/trackIndex.htm?documentCode=${NUMBER}`))
      .toMatchObject({ trackingNumber: NUMBER, carrier: 'anhua-international' });
  });
});

describe('Anhua International tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(new AnhuaTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER.toLowerCase()} `))
      .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'AU' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ANHUA_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(ANHUA_ORIGIN).toBe('http://www.ahgjgyl.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'anhua-international', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads a parcel Australia Post delivered under the same number, every row on Beijing’s clock', () => {
    const result = parseHualeiTrack(fixture('delivered'), NUMBER, ANHUA, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered Left with concierge/reception', last_update: '2026-10-19T09:51:55+08:00',
      service_name: '澳大利亚专线-F(鞋盒)', destination_country: 'AU', delivery_carrier: 'australia-post',
    });
    // Australia Post delivers the parcel under the number asked.
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('canonical_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(22);
    // Australia Post's own record dates the same scans three hours later, on eastern Australia's summer clock.
    expect(events.every((event) => event.time?.endsWith('+08:00'))).toBe(true);
    const at = (description: string) => events.filter((event) => event.description === description).map((event) => event.time);
    expect(at('Onboard for delivery')).toEqual(['2026-10-19T06:24:18+08:00']);
    expect(at('Your consignment has been picked up')).toEqual(['2026-10-16T14:36:26+08:00']);
    expect(at('In transit to next facility')).toHaveLength(3);
    // Rows in Chinese are shown in English, staged by the Chinese.
    expect(events.find((event) => event.description === 'Landed, clearing customs and collecting the goods'))
      .toMatchObject({ time: '2026-10-14T11:19:30+08:00', stage: 'customs', stage_source: 'carrier_map' });
    expect(events.find((event) => event.description === 'Declared for the crossing into Hong Kong')).toMatchObject({ stage: 'in_transit' });
    // The booked flight's day and Australia Post's approval of the data move nothing.
    for (const description of ['Expected on the flight of the 13th', 'Shipping information approved by Australia Post']) {
      expect(events.find((event) => event.description === description), description).toMatchObject({ stage: 'in_transit', stage_source: 'none' });
    }
    expect(events.find((event) => event.provider_code === 'ARRIVAL'))
      .toMatchObject({ time: '2026-10-05T16:55:54+08:00', description: 'Goods collected', location: '广州', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ time: '2026-09-18T11:39:13+08:00', description: 'Shipment information received', stage: 'registered' });
    // The platform's custom track row is held back as written ahead.
    expect(result.planned_events).toEqual([expect.objectContaining({ description: 'Sent to the transit warehouse at the port', stage: 'in_transit' })]);
    expect(JSON.stringify(result)).not.toMatch(/signature|CITIZEN|signperson|AHYSGJ/i);
  });

  it('finds the parcel by Anhua’s own waybill and the shipper’s reference, with Australia Post’s number to deliver under', () => {
    for (const number of ['AHYSGJ20261005165553123', '1545259']) {
      const found = parseHualeiTrack(fixture('delivered'), number, ANHUA, READ_AT)!;
      expect(found, number).toMatchObject({ delivery_carrier: 'australia-post', delivery_tracking_number: NUMBER });
      expect(found, number).not.toHaveProperty('canonical_tracking_number');
    }
  });

  it('hands nothing on without a row that names Australia Post, and drops the signatory', () => {
    expect([row('Shipping information approved by Australia Post'), row('Onboard for delivery'), row('Australia Post', 'ARRIVAL')]
      .map(isAnhuaAustraliaPostRow)).toEqual([true, false, false]);
    const reply = fixture('delivered');
    const record = reply[0].data[0];
    record.trackDetails = record.trackDetails.filter((detail: Record<string, string>) => !/Australia Post/.test(detail.track_content!));
    const found = parseHualeiTrack(reply, 'AHYSGJ20261005165553123', ANHUA, READ_AT)!;
    expect(found).not.toHaveProperty('delivery_carrier');
    expect(found).toMatchObject({ canonical_tracking_number: NUMBER });
    expect(splitAnhuaRow('Delivered Left with concierge/reception with signature from J CITIZEN', ''))
      .toEqual({ content: 'Delivered Left with concierge/reception', location: '' });
    expect(splitAnhuaRow('Item processed at sorting facility', 'SYDNEY')).toEqual({ content: 'Item processed at sorting facility', location: 'SYDNEY' });
  });

  it('settles the interface’s no-row answer with the page, which reads an unknown number as not found', async () => {
    expect(parseHualeiTrack(fixture('no-track'), UNKNOWN, ANHUA, READ_AT)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(unknownPage()));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${ANHUA_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHualeiPage(unknownPage(), UNKNOWN, ANHUA, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    const unknown = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(unknownPage()));
    await expect(adapter(environment(unknown)).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['39', `${NUMBER},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error, another parcel as inconclusive and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json([{ ack: 'true', data: {} }])))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json(fixture('delivered'))))).track({ number: '39BRK509054301000931599' }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('maps every wording it lists, in Chinese and in English, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      for (const wording of [entry.wording, ...('english' in entry && entry.english ? [entry.english] : [])]) {
        expect(statusMap.stage(null, normalizeStatusWording(wording)), wording).toBe(entry.stage ?? undefined);
      }
    }
    expect(anhuaEnglish(null, normalizeStatusWording('预计1号的航班'))).toBe('Expected on the flight of the 1st');
    expect(anhuaEnglish(null, normalizeStatusWording('11.2A，申报过港中'))).toBe('Declared for the crossing into Hong Kong');
    expect(statusMapAnswer({ carrier: 'anhua-international', description: '10.12C，申报过港中' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'anhua-international', description: 'Expected on the flight of the 22nd' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringContaining('booked') });
    expect(statusMapAnswer({ carrier: 'anhua-international', description: 'Shipping information approved by Australia Post' }))
      .toEqual({ kind: 'intentional_gap', note: expect.stringContaining('notice') });
    expect(statusMapAnswer({ carrier: 'anhua-international', description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierIdFromName } from '../../core/catalog/hints.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { HualeiTracker, parseHualeiPage, parseHualeiTrack, type HualeiRow } from '../gzyl/hualei.js';
import { adapter } from './adapter.js';
import carrier from './carrier.json' with { type: 'json' };
import { isLjsSagawaRow, LJS, LJS_ORIGIN, ljsClock, splitLjsRow } from './parser.js';
import { ljsEnglish, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, which `track.json` answers, and a string in no shape the tracker issues.
const NUMBER = '8811511589';
const UNKNOWN = 'ZZQX00000000000';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-27T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const unknownLookup = () => vi.fn<typeof fetch>().mockResolvedValueOnce(json(own('no-track.json'))).mockResolvedValueOnce(html(own('page-unknown.html')));
const row = (content: string, location: string, code = ''): HualeiRow => ({ clock: '2025-02-14 10:48:01', content, location, code });

describe('LJS numbers', () => {
  it('takes the forwarder’s names', () => {
    for (const name of ['LJS International Freight', 'LJS', '利佳顺国际货运', '深圳利佳顺国际货运代理有限公司']) {
      expect(carrierIdFromName(name), name).toBe('ljs');
    }
  });

  it('leaves its ten bare digits, which many carriers share, to the tracker', () => {
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('ljs');
  });
});

describe('LJS tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(own('track.json')));
      await expect(new HualeiTracker(LJS, { fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER} `))
        .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'JP' });
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe(`${LJS_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(LJS_ORIGIN).toBe('http://115.29.184.71:8082');
      expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(adapter(environment(fetcher))).toMatchObject({ id: 'ljs', recordsSteps: true, steps: ['direct', 'retry'] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a parcel Sagawa delivered in Japan: the line’s rows on Beijing’s clock, Sagawa’s steps on Japan’s, Sagawa named for the last leg', () => {
    const result = parseHualeiTrack(JSON.parse(own('track.json')), NUMBER, LJS, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', destination_country: 'JP', service_name: '大阪专线(BTHK)',
      delivery_carrier: 'sagawa', delivery_tracking_number: '364232978384',
      last_status_text: '配達完了', last_update: '2025-02-14T10:48:01+09:00',
    });
    expect(result.events?.map((event) => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2025-02-14T10:48:01+09:00', '配達完了', '前橋営業所', 'delivered'],
      ['2025-02-14T10:46:00+09:00', 'ご不在', '前橋営業所', 'failed_attempt'],
      ['2025-02-14T07:55:00+09:00', '配達中', '前橋営業所', 'out_for_delivery'],
      ['2025-02-13T18:16:00+09:00', '輸送中', '関東中継センター', 'in_transit'],
      ['2025-02-13T13:43:00+09:00', '集荷', '羽田営業所', 'in_transit'],
      ['2025-02-12T12:31:00+08:00', 'Flight arrived, in customs clearance', undefined, 'customs'],
      ['2025-02-12T09:26:00+08:00', 'Flight departed', undefined, 'in_transit'],
      ['2025-02-09T09:30:00+08:00', 'Booked on the flight of 2025/02/12', undefined, 'in_transit'],
      ['2025-02-08T17:45:43+08:00', '現地輸送中', undefined, 'in_transit'],
      ['2025-02-08T17:45:19+08:00', 'Goods leave the operation center', '深圳', 'in_transit'],
      ['2025-02-06T16:46:05+08:00', 'Arrived at the receiving point', '深圳', 'accepted'],
    ]);
    expect(result.events![0]).toMatchObject({ local_time: '2025-02-14T10:48:01', time_zone: 'Asia/Tokyo', time_zone_basis: 'carrier' });
    // The booked flight is a notice: it keeps the stage before it.
    expect(result.events![7]).toMatchObject({ stage_source: 'none' });
    // Sagawa's summary, its offices' telephone numbers as the place, is no scan.
    expect(JSON.stringify(result)).not.toMatch(/TEL|FAX|1個|signperson|customer_code|"OK\."/);
  });

  it('tells Sagawa’s copied steps by their arrow and office, and reads them on Japan’s clock', () => {
    for (const content of ['↓集荷', '?配達完了', '⇒配達完了']) {
      expect(isLjsSagawaRow(row(content, '前橋営業所')), content).toBe(true);
      expect(ljsClock(row(content, '関東中継センター'))).toEqual({ zone: 'Asia/Tokyo', basis: 'carrier' });
    }
    expect(isLjsSagawaRow(row('配達完了', '前橋営業所'))).toBe(false);
    expect(isLjsSagawaRow(row('↓集荷', '深圳'))).toBe(false);
    expect(isLjsSagawaRow(row('↓集荷', '前橋営業所', 'ARRIVAL'))).toBe(false);
    expect(ljsClock(row('航班到着/通关中', ''))).toBe('platform');
    expect(splitLjsRow('?配達完了', '前橋営業所')).toEqual({ content: '配達完了', location: '前橋営業所' });
    expect(splitLjsRow('1個', '羽田営業所 TEL:0000')).toEqual({ content: '', location: '' });
    expect(splitLjsRow('预配2025/02/12航班', '')).toEqual({ content: '预配2025/02/12航班', location: '' });
  });

  it('leaves the hand-off open without Sagawa’s steps, or when a channel names another carrier', () => {
    const payload = JSON.parse(own('track.json'));
    const [record] = payload[0].data;
    const steps = record.trackDetails;
    record.trackDetails = steps.slice(6);
    expect(parseHualeiTrack(payload, NUMBER, LJS, READ_AT)).not.toHaveProperty('delivery_carrier');
    record.trackDetails = steps;
    record.channel_name = 'Japan Post';
    expect(parseHualeiTrack(payload, NUMBER, LJS, READ_AT)?.delivery_carrier).not.toBe('sagawa');
  });

  it('reads the no-row answer for an unknown number, which the bare page settles as not found', async () => {
    expect(parseHualeiTrack(JSON.parse(own('no-track.json')), UNKNOWN, LJS, READ_AT)).toBeNull();
    const fetcher = unknownLookup();
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${LJS_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHualeiPage(own('page-unknown.html'), UNKNOWN, LJS, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The same page echoing a number, or without the search form, is a changed page.
    const echoing = own('page-unknown.html').replace("id='codes' value=''", `id='codes' value='${UNKNOWN}'`);
    expect(() => parseHualeiPage(echoing, UNKNOWN, LJS, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const formless = own('page-unknown.html').replace(/<textarea[\s\S]*?<\/textarea>/, '');
    expect(() => parseHualeiPage(formless, UNKNOWN, LJS, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('recognizes by the same lookup', async () => {
    await expect(adapter(environment(unknownLookup())).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(own('track.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['LJS', `${NUMBER},${UNKNOWN}`]) {
      await expect(adapter(environment(fetcher)).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a block page as a challenge, a changed reply as a schema error and a 429 as a rate limit, never as not found', async () => {
    const block = '<html><head><title>验证码</title></head><body>aliyun_waf</body></html>';
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html(block)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(json('[{"ack":"true","data":{}}]')))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(adapter(environment(vi.fn<typeof fetch>().mockResolvedValue(html('', 429)))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)) ?? null, entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'ljs', providerCode: null, description: '配達完了' })).toEqual({ kind: 'mapped', stage: 'delivered' });
    expect(statusMapAnswer({ carrier: 'ljs', providerCode: null, description: 'Flight arrived, in customs clearance' }))
      .toEqual({ kind: 'mapped', stage: 'customs' });
    for (const description of ['预配2025/02/12航班', 'Booked on the flight of 2025/02/12']) {
      expect(statusMapAnswer({ carrier: 'ljs', providerCode: null, description }), description).toMatchObject({ kind: 'intentional_gap' });
    }
    expect(statusMapAnswer({ carrier: 'ljs', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
    expect(ljsEnglish(null, normalizeStatusWording('预配2025/3/1航班'))).toBe('Booked on the flight of 2025/3/1');
  });

  it('links no plain-HTTP page', () => {
    expect(carrier.portal).not.toHaveProperty('searchUrl');
    expect(carrier.links).toEqual([]);
  });
});

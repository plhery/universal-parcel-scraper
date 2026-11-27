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
import { LINGXUN, LINGXUN_ORIGIN, lingxunClock } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, which `track.json` answers, and a string in no shape the tracker issues.
const NUMBER = 'LX000682622907';
const UNKNOWN = 'ZZQX00000000000';
// The lookup's moment, after the fixture's newest row.
const READ_AT = Date.parse('2026-11-27T00:00:00Z');
const own = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const unknownLookup = () => vi.fn<typeof fetch>().mockResolvedValueOnce(json(own('echo-unknown.json'))).mockResolvedValueOnce(html(own('page-unknown.html')));
const row = (content: string, location: string, code = ''): HualeiRow => ({ clock: '2025-11-07 10:56:00', content, location, code });

describe('LingXun Logistics numbers', () => {
  it('takes the forwarder’s names', () => {
    for (const name of ['LingXun Logistics', 'LingXun', '领讯物流', '深圳市领讯物流有限公司']) {
      expect(carrierIdFromName(name), name).toBe('lingxun-logistics');
    }
  });

  it('offers its LX numbers whole, and nothing shorter or longer', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['lingxun-logistics'] });
    for (const number of [NUMBER.slice(0, -1), `${NUMBER}0`, `LA${NUMBER.slice(2)}`, `XLX${NUMBER.slice(2)}`]) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('lingxun-logistics');
    }
  });
});

describe('LingXun Logistics tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    vi.useFakeTimers({ now: READ_AT, toFake: ['Date'] });
    try {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(own('track.json')));
      await expect(new HualeiTracker(LINGXUN, { fetcher, recorder: NOOP_RECORDER }).fetch(` ${NUMBER.toLowerCase()} `))
        .resolves.toMatchObject({ current_stage: 'delivered', destination_country: 'AU' });
      const [url, init] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe(`${LINGXUN_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
      expect(LINGXUN_ORIGIN).toBe('http://129.204.198.136:8082');
      expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(adapter(environment(fetcher))).toMatchObject({ id: 'lingxun-logistics', recordsSteps: true, steps: ['direct', 'retry'] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a parcel delivered in Queensland, the line’s rows on Beijing’s clock and the Australian copies on their wall clocks', () => {
    const result = parseHualeiTrack(JSON.parse(own('track.json')), NUMBER, LINGXUN, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', destination_country: 'AU', service_name: '全球专线-特敏感(LX-AU偏远)',
      last_status_text: 'Parcel delivered - authority to leave', last_update: null, last_update_local: '2025-11-13T06:49:27',
    });
    // The transfer field holds a 20-digit SSCC that no rule claims with high confidence, and no channel names a carrier.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events?.map((event) => [event.time ?? event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2025-11-13T06:49:27', 'Parcel delivered - authority to leave', 'Toowoomba', 'delivered'],
      ['2025-11-13T06:05:26', 'Parcel out for final mile carrier delivery', 'Toowoomba', 'out_for_delivery'],
      ['2025-11-07T10:57:00', 'Parcel processed', 'Mansfield', 'in_transit'],
      ['2025-11-07T10:56:00', 'Customs cleared', 'Mansfield, BRISBANE', 'in_transit'],
      ['2025-11-07T10:55:00', 'Parcel collected by carrier', 'Mansfield, BRISBANE', 'in_transit'],
      ['2025-11-06T21:03:00', 'Parcel arrived in destination country', 'Brisbane', 'in_transit'],
      ['2025-10-30T21:58:41+08:00', 'The package has arrived at the processing center', 'Treatment station', 'accepted'],
      ['2025-10-27T14:39:23+08:00', 'The electronic information of the goods has been received', undefined, 'registered'],
    ]);
    expect(result.events?.filter((event) => event.local_time).every((event) => !event.time)).toBe(true);
    // The line's custom track rows, all written in one second days ahead of their clocks, are held back.
    expect(result.planned_events?.map((event) => [event.description, event.location])).toEqual([
      ['The parcel arrived at the processing center', 'SZ'],
      ['The parcel depart the processing center', 'SZ'],
      ['The parcel arrived at the processing center', 'HK'],
      ['Customs Clearance Completed', 'HK'],
      ['The flight has taken off from its origin', 'HK'],
      ['The parcel arrived at the processing center', 'AU'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/signperson|customer_code|"ok"/i);
  });

  it('reads a row’s clock by its code, place and wording', () => {
    expect(lingxunClock(row('Parcel processed', 'Mansfield'))).toBe('wall');
    expect(lingxunClock(row('The package has arrived at the processing center', 'Treatment station', 'ARRIVAL'))).toBe('platform');
    expect(lingxunClock(row('The electronic information of the goods has been received', ''))).toBe('platform');
    expect(lingxunClock(row('Parcel processed', 'CN'))).toBe('platform');
    expect(lingxunClock(row('Parcel processed', '深圳'))).toBe('platform');
    expect(lingxunClock(row('货物离开操作中心', 'Shenzhen'))).toBe('platform');
  });

  it('reads the echo answer for an unknown number, which the page settles as not found', async () => {
    expect(parseHualeiTrack(JSON.parse(own('echo-unknown.json')), UNKNOWN, LINGXUN, READ_AT)).toBeNull();
    const fetcher = unknownLookup();
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls[1]![0]).toEqual(new URL(`${LINGXUN_ORIGIN}/trackIndex.htm`));
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
    expect(() => parseHualeiPage(own('page-unknown.html'), UNKNOWN, LINGXUN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('never reads the page for another number as not found', () => {
    expect(() => parseHualeiPage(own('page-unknown.html'), 'ZZQX00000000001', LINGXUN, READ_AT)).toThrow(expect.not.objectContaining({ kind: 'not_found' }));
  });

  it('recognizes by the same lookup', async () => {
    await expect(adapter(environment(unknownLookup())).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    const known = vi.fn<typeof fetch>().mockResolvedValue(json(own('track.json')));
    await expect(adapter(environment(known)).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
  });

  it('refuses a number the tracker cannot be asked for without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['LX', `${NUMBER},${UNKNOWN}`]) {
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
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'lingxun-logistics', providerCode: null, description: 'Parcel out for final mile carrier delivery' }))
      .toEqual({ kind: 'mapped', stage: 'out_for_delivery' });
    expect(statusMapAnswer({ carrier: 'lingxun-logistics', providerCode: null, description: 'Synthetic wording' })).toEqual({ kind: 'unknown' });
  });

  it('flags its wall clocks and links the site’s HTTPS tracking page, not the plain-HTTP tracker', () => {
    expect(carrier.tracking).toMatchObject({ localClocks: true });
    expect(carrier.portal.searchUrl).toBe('https://www.lingxun.top/a/kehufuwu/');
    expect(carrier.links).toEqual([]);
  });
});

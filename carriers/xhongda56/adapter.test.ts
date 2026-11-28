import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, XHONGDA56_API, XHONGDA56_SITE, Xhongda56Tracker, xhongda56LookupUrl } from './adapter.js';
import { normalizeXhongda56Number, parseXhongda56, xhongda56Place, xhongda56Row } from './parser.js';
import { statusMap, xhongda56Stage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const NETWORK = numbers.records[1]!.number;
const UNKNOWN = '1999999999';
// After the samples' newest rows, on China's clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'delivered' | 'network' | 'not-found';
const bytes = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));
// The server answers in GBK.
const raw = (name: Fixture) => new TextDecoder('gb18030').decode(bytes(name));
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('Xinhongda Logistics tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport, and reads its GBK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 3)} ${NUMBER.slice(3, 5)}-${NUMBER.slice(5)}`;
    const result = await new Xhongda56Tracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '签收录入' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(xhongda56LookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(XHONGDA56_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: XHONGDA56_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xhongda56', step: 'direct', outcome: 'ok' }));
  });

  it('reads the test number newest first, on China\'s clock, without who signed', () => {
    const result = parseXhongda56(raw('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '签收录入', last_update: '2022-08-30T10:14:00+08:00', last_update_local: '2022-08-30T10:14',
      expected_delivery: null, weight_kg: 18 });
    // The destination is a Chinese town, not a country.
    for (const field of ['destination_country', 'delivery_carrier', 'delivery_tracking_number']) expect(result).not.toHaveProperty(field);
    expect(result.events!.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2022-08-30T10:14:00+08:00', '湖北阳新站', '签收录入', 'delivered'],
      ['2022-08-30T05:12:00+08:00', '黄石分拨中心', '发往湖北阳新站', 'in_transit'],
      ['2022-08-30T02:11:00+08:00', '湖北黄石分拨中心', '黄石分拨中心缷车扫描', 'in_transit'],
      ['2022-08-28T23:07:00+08:00', '温州分拨中心', '扫描裝车发往湖北黄石分拨中心', 'in_transit'],
      ['2022-08-28T16:03:00+08:00', '乐清新宏达', '发往温州分拨中心', 'in_transit'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/某某|签收人/);
  });

  it('places the bracketed sentences where the station they name is, not at the next stop', () => {
    const result = parseXhongda56(raw('network'), NETWORK, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '快件已被签收',
      last_update: '2022-10-18T17:12:00+08:00' });
    expect(result.events!.map((event) => [event.location, event.stage])).toEqual([
      ['H无锡堰桥', 'delivered'], ['H无锡堰桥', 'in_transit'], ['无锡分拨', 'in_transit'], ['无锡分拨', 'in_transit'],
      ['温州分拨', 'in_transit'], ['温州分拨', 'in_transit'], ['H温州北白象', 'accepted'],
    ]);
    expect(result.events!.at(-1)).toMatchObject({ description: '快件已在【H温州北白象】被揽件' });
    expect(result.events![2]).toMatchObject({ description: '快件已从【无锡分拨】出发,下一站是【H无锡堰桥】,货物正在运输中' });
    expect(JSON.stringify(result)).not.toMatch(/某某|揽件员|签收人/);
  });

  it('leaves out the staff a row names, who signed and anything after a phone', () => {
    expect(xhongda56Row('快件已在【H温州北白象】被揽件,揽件员是【某某】')).toEqual({ description: '快件已在【H温州北白象】被揽件' });
    expect(xhongda56Row('签收录入 签收人 某某')).toEqual({ description: '签收录入' });
    expect(xhongda56Row('快件已被签收，签收人:某某')).toEqual({ description: '快件已被签收' });
    expect(xhongda56Row('【H无锡堰桥】正在派件,派件员是【某某】,电话13800000000')).toEqual({ description: '【H无锡堰桥】正在派件' });
    expect(xhongda56Place('H无锡堰桥', '快件已从【无锡分拨】出发,下一站是【H无锡堰桥】')).toBe('无锡分拨');
    expect(xhongda56Place('温州分拨中心', '扫描裝车发往湖北黄石分拨中心')).toBe('温州分拨中心');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseXhongda56(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseXhongda56(raw('delivered'), NETWORK, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXhongda56(changed(/^100/, '-1'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXhongda56(changed('<DATETIME>2022-08-30 02:11', '<DATETIME>2022-08-32 02:11'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXhongda56(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A row dated after the lookup is not a scan yet.
    expect(parseXhongda56(raw('delivered'), NUMBER, Date.parse('2022-08-30T08:00:00+08:00')).last_update_local).toBe('2022-08-30T05:12');
    const lookup = (body: BodyInit, init?: ResponseInit) => new Xhongda56Tracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new Xhongda56Tracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.xhongda56.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeXhongda56Number(` ${NUMBER} `)).toBe(NUMBER);
    for (const number of ['16826', 'ABCDEFGHIJ', '1'.repeat(31), '168/2648', '']) {
      expect(() => normalizeXhongda56Number(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new Xhongda56Tracker({ fetcher }).fetch('16826')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new Xhongda56Tracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'xhongda56', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the rows by their sentence, whatever station they name', () => {
    expect(xhongda56Stage('发往湖北黄石分拨中心')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(xhongda56Stage('快件已到达【湖北阳新站】,会尽快安排中转,请耐心等待')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(xhongda56Stage('快件已在【乐清新宏达】被揽件')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(statusMap.stage(null, '签收录入')).toBe('delivered');
    expect(statusMap.stage('1', '签收录入')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});

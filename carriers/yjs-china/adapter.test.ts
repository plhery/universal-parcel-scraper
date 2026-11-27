import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YJS_CHINA_TRACKER, YjsChinaTracker } from './adapter.js';
import { normalizeYjsChinaNumber, parseYjsChina, yjsChinaText } from './parser.js';
import { statusMap, yjsChinaStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
// The invented number of the not-found fixture.
const UNKNOWN = 'CHNYJS90817263';
// After the sample's newest row.
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
const html = (name: 'signed' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const withRows = (rows: string) => html('signed').replace(/<tr>\s*<td>\d{4}-[\s\S]*<\/tr>(\s*<\/tbody>)/, `${rows}$1`);
const row = (clock: string, wording: string) => `<tr><td>${clock}</td><td></td><td>${wording}</td><td></td></tr>`;
// The synthetic name and phones the sample's fixture carries in place of the real ones.
const PERSONAL = /张三|13900001111|13900002222|13900003333|0755-1234567/;

describe('YJS Express tracking lookup', () => {
  it('posts the whole number to the tracking page through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(html('signed')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 6)} ${NUMBER.slice(6, 10)}-${NUMBER.slice(10)}`.toLowerCase();
    const result = await new YjsChinaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.events).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(YJS_CHINA_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Referer: YJS_CHINA_TRACKER, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ WayBillNo: NUMBER });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'yjs-china', step: 'direct', outcome: 'ok' }));
  });

  it("reads the sample newest first, each row's wall clock dated on China's clock, without the people and phones it names", () => {
    const result = parseYjsChina(html('signed'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '广东省深圳市宝安区龙华公司 已签收。快件已送达', last_update: '2021-04-24T19:55:00+08:00',
      last_update_local: '2021-04-24T19:55:00', expected_delivery: null });
    expect(result.events).toEqual([
      { time: '2021-04-24T19:55:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2021-04-24T19:55:00',
        description: '广东省深圳市宝安区龙华公司 已签收。快件已送达', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2021-04-24T16:34:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2021-04-24T16:34:00',
        description: '快件已暂存至深圳龙华民治樟坑区98栋菜鸟驿站', stage: 'ready_for_pickup', stage_source: 'carrier_map' },
      { time: '2021-04-24T14:24:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2021-04-24T14:24:00',
        description: '【广东省深圳市宝安区龙华公司】 派件中', stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
  });

  it('takes people, phones and pickup codes out, keeps stations, a waybill and a signature by the sender, and drops a row left with nothing', () => {
    expect(yjsChinaText('【赤峰市红山区公司】 已揽收 揽件员: 李四 13900004444')).toBe('【赤峰市红山区公司】 已揽收');
    expect(yjsChinaText('【赤峰市红山区公司】 派件中 派送员：王五，手机：13900005555')).toBe('【赤峰市红山区公司】 派件中');
    expect(yjsChinaText('快件已存放至丰巢快递柜，取件码：A1234，如有疑问请拨打0476-1234567')).toBe('快件已存放至丰巢快递柜');
    expect(yjsChinaText('已签收，签收人：赵六，如有疑问，请联系')).toBe('已签收');
    expect(yjsChinaText('已签收，签收人：寄件人')).toBe('已签收，签收人：寄件人');
    expect(yjsChinaText('已转中通快递，单号：73194550922032')).toBe('已转中通快递，单号：73194550922032');
    const result = parseYjsChina(withRows(row('2024-03-01 10:00:00', '派件人: 张三 电话 13900001111')
      + row('2024-03-01 09:00:00', '【赤峰市红山区公司】 派件中 派件人: 张三 电话 13900001111')), NUMBER, READ_AT);
    expect(result.events).toHaveLength(1);
    expect(result.events![0]).toMatchObject({ description: '【赤峰市红山区公司】 派件中', stage: 'out_for_delivery' });
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
  });

  it('keeps one row of a repeated row, and lists rows of one second in their order', () => {
    const result = parseYjsChina(withRows(row('2024-03-01 09:00:00', '快件已暂存至赤峰红山区菜鸟驿站')
      + row('2024-03-01 09:00:00', '【赤峰市红山区公司】 派件中') + row('2024-03-01 09:00:00', '快件已暂存至赤峰红山区菜鸟驿站')), NUMBER, READ_AT);
    expect(result.events!.map((event) => event.description)).toEqual(['快件已暂存至赤峰红山区菜鸟驿站', '【赤峰市红山区公司】 派件中']);
    expect(result.current_stage).toBe('ready_for_pickup');
  });

  it('leaves a row the clock would date after the lookup its wall clock alone', () => {
    const result = parseYjsChina(html('signed'), NUMBER, Date.parse('2021-04-24T10:00:00Z'));
    expect(result.events![0]).toEqual({ local_time: '2021-04-24T19:55:00', description: '广东省深圳市宝安区龙华公司 已签收。快件已送达',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2021-04-24T19:55:00' });
  });

  it("reads the page's empty table for the number asked as not found and anything else as a failure, never as not found", async () => {
    expect(() => parseYjsChina(html('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    // The page for another number, or one that does not say which number it read, is not this one's.
    expect(() => parseYjsChina(html('not-found'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYjsChina(html('signed'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYjsChina(html('not-found').replace(`value="${UNKNOWN}"`, 'value=""'), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYjsChina(html('not-found').replace('name="WayBillNo"', 'name="Other"'), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYjsChina(html('not-found').replace('layui-table printTable', 'layui-table'), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYjsChina(html('not-found').replace('地点和跟踪进度', '备注'), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYjsChina(withRows(row('2021-04-31 19:55:00', '已签收')), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYjsChina(withRows(row('24/04/2021 19:55', '已签收')), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYjsChina(withRows('<tr><td>2021-04-24 19:55:00</td><td>已签收</td></tr>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYjsChina(withRows(row('2021-04-24 19:55:00', '派件人: 张三 电话 13900001111')), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new YjsChinaTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(html('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(html('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.yjs-china.com/Home/NewIndex' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    // ASP.NET's error page, sent with HTTP 200 by a misconfigured site, is the site down, not the parcel missing.
    const failure = "<html><head><title>Runtime Error</title></head><body><h1>Server Error in '/' Application.</h1></body></html>";
    await expect(lookup(failure)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(failure, { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeYjsChinaNumber(` ${NUMBER.toLowerCase()} `)).toBe(NUMBER);
    for (const number of ['CHN12', 'CHNYJSABCDEF', `${NUMBER};${UNKNOWN}`, '1'.repeat(31), '']) {
      expect(() => normalizeYjsChinaNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new YjsChinaTracker({ fetcher }).fetch(`${NUMBER};${UNKNOWN}`)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new YjsChinaTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'yjs-china', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('answers each wording statuses.json records by its stage, and other branches and stations by the same patterns', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMap.stage(null, wording), wording).toBe(stage);
      expect(yjsChinaStage(wording), wording).toEqual({ stage, source: 'carrier_map' });
    }
    expect(statusMap.stage(null, '【内蒙古赤峰市红山区公司】 派件中')).toBe('out_for_delivery');
    expect(statusMap.stage(null, '快件已存放至赤峰红山区兴安街丰巢快递柜')).toBe('ready_for_pickup');
    expect(statusMap.stage(null, '【赤峰市红山区公司】 已签收')).toBe('delivered');
    expect(statusMap.stage(null, '已签收')).toBe('delivered');
    expect(statusMap.stage('1', '已签收')).toBeUndefined();
    expect(yjsChinaStage('已签收，签收人：寄件人')).toMatchObject({ stage: 'returned' });
  });
});

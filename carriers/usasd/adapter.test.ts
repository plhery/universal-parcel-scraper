import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DsyTracker, dsyLookupUrl, parseDsy, USASD } from './adapter.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'SDL9901010417';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const page = (name: 'collect' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('SD Group tracking lookup', () => {
  it('asks the tenant\'s search for the number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('collect')));
    const result = await new DsyTracker(USASD, { fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER, { budgetMs: 5000 });
    expect(result.events).toHaveLength(32);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(dsyLookupUrl(USASD, NUMBER));
    expect(String(url)).toBe(`https://www.usasd.com/index.php?c=index&f=search&sn=${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'usasd', steps: ['direct', 'retry'] });
  });

  it('reads each row on its clock and hands the parcel to Yunda by the header\'s number', () => {
    const result = parseDsy(USASD, page('collect'), NUMBER, READ_AT);
    expect(result).toMatchObject({ current_stage: 'ready_for_pickup', current_stage_source: 'carrier_map',
      last_status_text: '【代收点】您的快件已暂存至丰巢柜，请及时领取签收', last_update: '2026-11-16T08:45:45+08:00',
      origin_country: 'US', destination_country: 'CN', delivery_carrier: 'yunda', delivery_tracking_number: '7790085616598' });
    const events = result.events!;
    expect(events.slice(0, 2).map((event) => [event.description, event.stage])).toEqual([
      ['【代收点】您的快件已暂存至丰巢柜，请及时领取签收', 'ready_for_pickup'], ['【上海市】上海青浦区新城公司 正在为您派送', 'out_for_delivery'],
    ]);
    expect(events.find((event) => event.description === '到达：【西安口岸】包裹准备清关')).toEqual({ time: '2026-11-13T11:45:17+08:00',
      time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2026-11-13T11:45:17', description: '到达：【西安口岸】包裹准备清关',
      stage: 'customs', stage_source: 'carrier_map' });
    expect(events.find((event) => event.description === '【美国 - 纽约】包裹已到达【纽约顺达转运仓】')).toMatchObject({
      time: '2026-10-23T11:33:44-04:00', time_zone: 'America/New_York', time_zone_basis: 'place' });
    expect(events.find((event) => event.description === '到达：【中国 - 西安】国际干线运输已到达【XIY西安】')).toMatchObject({
      time: '2026-11-13T08:45:14+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'place' });
    const landed = events.find((event) => event.description === '【包裹已落地国内，等待航司中转】')!;
    expect(landed).toMatchObject({ local_time: '2026-11-10T07:25:53', stage: 'in_transit' });
    expect(landed.time).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ time: '2026-10-11T11:19:51+08:00', description: '会员后台运单创建成功', stage: 'registered' });
    expect(events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/某|13800000000|0000000|地址|电话|快递员|微信|呼叫/);
  });

  it('reads the tips page as not found and the page asking for a number as inconclusive', async () => {
    expect(() => parseDsy(USASD, page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const asked = page('not-found').replace('运单信息不存在', '请填写运单号查询');
    expect(() => parseDsy(USASD, asked, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found')));
    await expect(new DsyTracker(USASD, { fetcher }).fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('names SD Group for SDL and ten digits', () => {
    expect(detectCarrierMatch(NUMBER).candidates).toEqual(['usasd']);
    expect(detectCarrierMatch(`${NUMBER}0`).candidates).not.toContain('usasd');
  });

  it('maps each text by its form in statuses.json', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('【北京市】已到达 北京分拨交付中心'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('纽约2号仓已入库，待打包'))).toBe('accepted');
  });
});

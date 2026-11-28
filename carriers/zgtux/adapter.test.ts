import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, normalizeZgtuxNumber, parseZgtux, ZgtuxTracker, zgtuxLookupUrl, zgtuxText } from './adapter.js';
import { statusMap, zgtuxStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const JD = numbers.records[0]!.number;
const DEPPON = numbers.records[1]!.number;
const UNKNOWN = 'TX950731984';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const shell = (inner: string) => `<!DOCTYPE html><html><head><meta charset="utf-8" /><title>运单查询</title></head><body>
  <input type="text" id="txtNo" maxlength="12" value='' /><br />${inner}</body></html>`;
// The tracker's answer for a waybill it does not know, as it gave it for an invented number.
const notFound = (number: string) => shell(`<h3 style="color:#666;">运单号：${number}</h3><hr/><ul class="layui-timeline"><li>查无相关路由信息</li></ul>`);
const item = (clock: string, text: string) => `<li class="layui-timeline-item"><i class="layui-icon layui-timeline-axis">&#xe63f;</i>`
  + `<div class="layui-timeline-content layui-text"><h3 class="layui-timeline-title">${clock}</h3><p>${text}</p></div></li>`;
const timeline = (number: string, items: string[]) => shell(`<h3 style="color:#666;">运单号：${number}</h3><hr/><ul class="layui-timeline">${items.join('')}</ul>`);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Tuxing Supply Chain tracking lookup', () => {
  it('asks the routes page for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered-jd')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new ZgtuxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${JD.toLowerCase()} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(15);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://vip.zgtux.com/routes?no=${JD}`);
    expect(zgtuxLookupUrl(JD)).toBe(`https://vip.zgtux.com/routes?no=${JD}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zgtux', step: 'direct', outcome: 'ok' }));
  });

  it('reads a JD Logistics route on China\'s clock, newest first, without its couriers or phones', () => {
    const result = parseZgtux(page('delivered-jd'), JD, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已送达至【店里】', last_update: '2026-10-08T09:18:00+08:00', last_update_local: '2026-10-08T09:18:00',
      delivered_at: '2026-10-08T09:18:00+08:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-10-08T09:18:00', '您的快件已送达至【店里】', 'delivered'],
      ['2026-10-08T08:43:00', '您的快件正在派送中，请您准备签收', 'out_for_delivery'],
      ['2026-10-08T07:32:00', '您的快件已到达【漳州朝阳站】', 'in_transit'],
      ['2026-10-08T07:09:00', '您的快件已到达【漳州朝阳站】', 'in_transit'],
      ['2026-10-08T05:39:00', '您的快件已离开【厦门集散分拣中心】，正在发往下一站【漳州朝阳站】的路上', 'in_transit'],
      ['2026-10-08T01:15:00', '您的快件已离开【厦门集散分拣中心】，正在发往下一站【漳州朝阳站】的路上', 'in_transit'],
      ['2026-10-08T00:06:00', '厦门集散分拣中心分拣中心已收箱，箱号BC1002261007241483523429', 'in_transit'],
      ['2026-10-07T22:48:00', '您的快件已到达【厦门集散分拣中心】', 'in_transit'],
      ['2026-10-07T22:47:00', '您的快件已到达【厦门集散分拣中心】', 'in_transit'],
      ['2026-10-07T22:15:00', '您的快件已到达【厦门集散分拣中心】', 'in_transit'],
      ['2026-10-07T21:18:00', '您的快件已离开【厦门莲坂站】，正在发往下一站【厦门集散分拣中心】的路上', 'in_transit'],
      ['2026-10-07T21:17:00', '您的快件已离开【厦门莲坂站】，正在发往下一站【厦门集散分拣中心】的路上', 'in_transit'],
      ['2026-10-07T20:41:00', '您的快件已到达【厦门莲坂站】，准备装车', 'in_transit'],
      ['2026-10-07T19:20:00', '京东快递已取件', 'accepted'],
      ['2026-10-07T16:21:00', '运单录入', 'registered'],
    ]);
    expect(result.events!.at(-1)).toEqual({ time: '2026-10-07T16:21:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2026-10-07T16:21:00', description: '运单录入', stage: 'registered', stage_source: 'carrier_map' });
    // The couriers and phones are gone, whatever the fixture put in their place.
    expect(JSON.stringify(result)).not.toMatch(/某某|1380000000|电话/u);
  });

  it('reads a Deppon route the same way', () => {
    const result = parseZgtux(page('delivered-deppon'), DEPPON, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2023-05-18T18:49:00+08:00' });
    expect(result.events!.map((event) => [event.description, event.stage])).toEqual([
      ['【H】株洲株洲县营业部，已签收，签收人类型：本人', 'delivered'],
      ['【H】株洲株洲县营业部，派送中', 'out_for_delivery'],
      ['【H】株洲株洲县营业部，运输中，到达【H】株洲株洲县营业部', 'in_transit'],
      ['长沙转运场，运输中，离开【长沙转运场】，下一部门【【H】株洲株洲县营业部】', 'in_transit'],
      ['长沙转运场，运输中，到达长沙转运场', 'in_transit'],
      ['重庆转运场，运输中，离开【重庆转运场】，下一部门【长沙转运场】', 'in_transit'],
      ['重庆转运场，运输中，到达重庆转运场', 'in_transit'],
      ['重庆万州区石峰支路营业部，运输中，离开【重庆万州区石峰支路营业部】，下一部门【重庆转运场】', 'in_transit'],
      ['重庆万州区石峰支路营业部，您的订单已被收件员揽收,【重庆万州区石峰支路营业部】库存中', 'accepted'],
      ['运单录入', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/某某|1380000000|体温|口罩/u);
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseZgtux(page('delivered-jd'), JD, Date.parse('2026-10-08T01:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![2]).toMatchObject({ time: '2026-10-08T07:32:00+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-10-08T09:18:00' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('cuts a relayed row at its courier, phone or courtesy line', () => {
    expect(zgtuxText('您的快件已送达至【店里】，快递员：张三，联系电话：13800000000，营业部电话：13800000001，每一次托付都是信任的延续'))
      .toBe('您的快件已送达至【店里】');
    expect(zgtuxText('【某营业部】，派送中，德邦已开启”安全呼叫“，保护您的电话隐私。,派送人：张三,电话:13800000000')).toBe('【某营业部】，派送中');
    expect(zgtuxText('您的快件已离开【甲站】，正在发往下一站【乙站】的路上。三角梅绽放的街巷')).toBe('您的快件已离开【甲站】，正在发往下一站【乙站】的路上');
    expect(zgtuxText('请拨打13800000000')).toBe('');
  });

  it('reads the not-found line under the number asked as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseZgtux(notFound(UNKNOWN), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseZgtux(notFound('TX950731985'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZgtux(page('delivered-jd'), DEPPON, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZgtux(shell(''), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZgtux(shell('<p>请求过于频繁请稍候再试</p>'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseZgtux(timeline(UNKNOWN, []), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZgtux(timeline(UNKNOWN, ['<li>查无相关路由信息</li>', item('2026-10-07 16:21', '运单录入')]), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZgtux(timeline(UNKNOWN, [item('2026-02-30 16:21', '运单录入')]), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZgtux(timeline(UNKNOWN, [item('2026-10-07 16:21', '请拨打13800000000')]), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new ZgtuxTracker({
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) }).fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(notFound(UNKNOWN))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(notFound(UNKNOWN), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://vip.zgtux.com/login' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeZgtuxNumber(JD.toLowerCase())).toBe(JD);
    for (const number of ['TX100', 'TUXINGSC', `T${'1'.repeat(30)}`, `${JD},${DEPPON}`, '']) {
      expect(() => normalizeZgtuxNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ZgtuxTracker({ fetcher }).fetch('TX1007&no=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new ZgtuxTracker({ fetcher }).fetch(JD, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'zgtux', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('leaves its waybills to explicit selection', () => {
    for (const number of [JD, DEPPON]) expect(detectCarrierMatch(number).candidates).not.toContain('zgtux');
  });

  it('maps each text in statuses.json, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('广州转运场，运输中，离开【广州转运场】，下一部门【【A】佛山南海营业部】'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('【A】佛山南海营业部，派送中'))).toBe('out_for_delivery');
    expect(statusMap.stage(null, normalizeStatusWording('您的快件已到达【广州分拣中心】'))).toBe('in_transit');
    expect(zgtuxStage('新的状态')).toBeNull();
  });
});

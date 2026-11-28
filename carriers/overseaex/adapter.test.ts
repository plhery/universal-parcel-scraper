import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DsyTracker, dsyLookupUrl, dsyText, normalizeDsyNumber, OVERSEAEX, parseDsy } from './adapter.js';
import { dsyStage } from './dsyexpressStatus.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'OE99010100417';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const page = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const parse = (body: string, number = NUMBER, readAt = READ_AT) => parseDsy(OVERSEAEX, body, number, readAt);

describe('Oversea Express tracking lookup', () => {
  it('asks the tenant\'s search for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const typed = `${NUMBER.slice(0, 6).toLowerCase()} ${NUMBER.slice(6)}`;
    const result = await new DsyTracker(OVERSEAEX, { fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(typed, { budgetMs: 5000 });
    expect(result.events).toHaveLength(13);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(dsyLookupUrl(OVERSEAEX, NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe('https://www.overseaex.com/index.php');
    expect(Object.fromEntries(asked.searchParams)).toEqual({ c: 'index', f: 'search', sn: NUMBER });
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'overseaex', step: 'direct', outcome: 'ok' }));
  });

  it('reads the platform\'s rows and BEST Express\'s on China\'s clock, newest first, without the courier or the signer', () => {
    const result = parse(page('delivered'));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '北京市【北京房山区窦店分部】，已签收', last_update: '2018-05-10T16:15:48+08:00',
      last_update_local: '2018-05-10T16:15:48', delivered_at: '2018-05-10T16:15:48+08:00', expected_delivery: null,
      origin_country: 'US', destination_country: 'CN' });
    // BEST Express no longer tracks under its own name, so the header's courier number names no delivery carrier.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const events = result.events!;
    expect(events[0]).toEqual({ time: '2018-05-10T16:15:48+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2018-05-10T16:15:48', location: '北京市', description: '北京市【北京房山区窦店分部】，已签收',
      original_description: '北京市|北京市【北京房山区窦店分部】，已签收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[1]).toMatchObject({ description: '北京市【北京房山区窦店分部】，正在派件', stage: 'out_for_delivery' });
    expect(events.find((event) => event.description!.startsWith('美国海关'))).toEqual({ time: '2018-05-02T02:40:57+08:00',
      time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2018-05-02T02:40:57', description: '美国海关，配载航班',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events.at(-1)).toMatchObject({ local_time: '2018-04-26T09:36:08', description: '运单创建成功，等待扣款处理', stage: 'registered' });
    expect(events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/某|13800000000|0532-|转运仓\//);
  });

  it('takes people, phones, addresses and the courtesy after them out of a row\'s text', () => {
    expect(dsyText('北京市|北京市【北京房山区窦店分部】，某某某 已签收')).toBe('北京市|北京市【北京房山区窦店分部】，已签收');
    expect(dsyText('北京市|北京市【北京房山区窦店分部】，【某某某/13800000000】正在派件')).toBe('北京市|北京市【北京房山区窦店分部】，正在派件');
    expect(dsyText('您的快件已派送至本人，如有疑问请电联快递员【某某，电话：13800000000】。您的体验对于我们至关重要'))
      .toBe('您的快件已派送至本人');
    expect(dsyText('快件交给【某某，联系电话：13800000000】，正在派送途中（如有任何问题可先联系我）')).toBe('快件正在派送途中');
    expect(dsyText('快件到达 【沈阳苏家屯加工厂店，地址：某某路1号】')).toBe('快件到达 【沈阳苏家屯加工厂店】');
    expect(dsyText('【代收点】您的快件已暂存至某某小区1号丰巢柜，地址：某某小区1号丰巢柜，请及时领取签收，如有取件码问题，请电联快递员：某某(13800000000)'))
      .toBe('【代收点】您的快件已暂存至丰巢柜，请及时领取签收');
    expect(dsyText('【上海市】上海青浦区新城公司(021-00000000) 快递员 某某某(13800000000) 正在为您派送【95126为韵达快递员外呼专属号码，请放心接听】'))
      .toBe('【上海市】上海青浦区新城公司 正在为您派送');
    expect(dsyText('【上海市】已离开 上海市青浦区新城网格仓[021-00000000]；发往 上海青浦区新城公司（如遇物流问题无需找商家/平台，拨打专属电话：02100000000为您解决）'))
      .toBe('【上海市】已离开 上海市青浦区新城网格仓；发往 上海青浦区新城公司');
    expect(dsyText('【西安市】陕西西安未央草滩公司-某某某(13800000000) 已揽收（如遇物流问题无需找商家/平台）')).toBe('【西安市】陕西西安未央草滩公司 已揽收');
    expect(dsyText('【北京市】的派件员【某某】正在派件')).toBe('【北京市】正在派件');
    expect(dsyText('快件已被 某某 签收')).toBe('快件已被签收');
    // A courier named without a phone takes the clause with them.
    expect(dsyText('包裹已到达，快递员某某正在派件')).toBe('包裹已到达');
    expect(dsyText('请致电 138****0000')).toBe('');
    expect(dsyText('百世快递已揽件，快递单号:50000000000001')).toBe('百世快递已揽件，快递单号:50000000000001');
  });

  it('names the courier in China from the header or its pickup row when the catalog has it and its rules offer the number', () => {
    const header = (text: string) => page('delivered').replace(/（百世快递：\d+）/u, text);
    expect(parse(header('（顺丰速运：SF1000000000001）'))).toMatchObject({ delivery_carrier: 'sf-express', delivery_tracking_number: 'SF1000000000001' });
    // A number that is not that courier's, or the waybill itself, names none.
    expect(parse(header('（顺丰速运：AB12345678）'))).not.toHaveProperty('delivery_carrier');
    expect(parse(header(`（顺丰速运：${NUMBER}）`))).not.toHaveProperty('delivery_carrier');
    const row = page('delivered').replace(/（百世快递：\d+）/u, '').replace(/百世快递已揽件，快递单号:\d+/u, '顺丰速运已揽件单号:SF1000000000001');
    expect(parse(row)).toMatchObject({ destination_country: 'CN', delivery_carrier: 'sf-express', delivery_tracking_number: 'SF1000000000001' });
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parse(page('delivered'), NUMBER, Date.parse('2018-05-10T05:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2018-05-10T09:05:56+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2018-05-10T16:15:48' });
  });

  it('reads the tips page\'s 运单信息不存在 as not found and anything else as a failure, never as not found', async () => {
    expect(() => parse(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(page('not-found').replace('运单信息不存在', '请填写运单号查询'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(page('not-found').replace('Powered by DsyExpress!', ''), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = page('delivered').replace(/<tbody>[\s\S]*<\/tbody>/u, '<tbody></tbody>');
    expect(() => parse(empty)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = page('delivered').replace('2018-05-10 16:15:48', '2018-02-30 16:15:48');
    expect(() => parse(clock)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const cells = page('delivered').replace('<td class="text-center">2018-05-10 16:15:48</td>', '');
    expect(() => parse(cells)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new DsyTracker(OVERSEAEX, { fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('not-found'), { status: 500 })).rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.overseaex.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"error":"busy"}', { headers: { 'content-type': 'application/json' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeDsyNumber(OVERSEAEX, NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['12345', 'OEABCDEFGH', `O${'1'.repeat(30)}`, 'OE1804/2600062', '']) {
      expect(() => normalizeDsyNumber(OVERSEAEX, number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new DsyTracker(OVERSEAEX, { fetcher }).fetch('OE1&f=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new DsyTracker(OVERSEAEX, { fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'overseaex', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps each text by its form in statuses.json, with brackets, numbers and towns as …, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('上海市【上海转运中心】，正发往【上海浦东分部】'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('百世快递已揽件，快递单号:50000000000001'))).toBe('in_transit');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(dsyStage(statusMap, '已签收')).toMatchObject({ stage: 'delivered' });
    expect(dsyStage(statusMap, '新的状态')).toBeNull();
  });
});

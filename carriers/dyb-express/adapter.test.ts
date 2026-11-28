import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DYB_TRACK, DybTracker, dybLookupUrl, dybText, normalizeDybNumber, parseDyb } from './adapter.js';
import { dybStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const YTO = numbers.records[1]!.number;
const UNKNOWN = 'S820000999999';
// After the samples' newest rows, on Beijing time.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'zto' | 'yto' | 'not-found';
const page = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('DYB Express tracking lookup', () => {
  it('opens the tracking page for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('zto')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 5)} ${NUMBER.slice(5, 9)}-${NUMBER.slice(9)}`.toLowerCase();
    const result = await new DybTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', delivery_carrier: 'zto' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(dybLookupUrl(NUMBER));
    expect(String(url)).toBe(`${DYB_TRACK}?no=${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dyb-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads the test number on Beijing time, with ZTO as the courier in China', () => {
    const result = parseDyb(page('zto'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '快件已在 【长宁】 签收, 您的快递已经妥投', last_update: '2022-07-25T13:03:39+08:00',
      last_update_local: '2022-07-25T13:03:39', expected_delivery: null, delivery_carrier: 'zto', delivery_tracking_number: '73187101087354' });
    const events = result.events!;
    // The page repeats two of ZTO's rows; each is read once.
    expect(events).toHaveLength(18);
    expect(events.map((event) => event.stage)).toEqual(['delivered', 'out_for_delivery', ...Array<string>(7).fill('in_transit'),
      'customs', ...Array<string>(5).fill('in_transit'), 'accepted', 'accepted', 'registered']);
    expect(events[1]).toEqual({ time: '2022-07-25T07:09:17+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2022-07-25T07:09:17', location: '长宁', description: '【长宁】 正在第1次派件,并耐心等待', stage: 'out_for_delivery',
      stage_source: 'carrier_map' });
    expect(events[8]).toMatchObject({ location: '天津东丽南部', description: '【天津东丽南部】 已揽收' });
    expect(events.at(-1)).toMatchObject({ description: '创建电子订单', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/某某|家门口|4PX|13800000000|021-|电话|签收人/);
  });

  it('reads YTO\'s rows without the people and phones they name', () => {
    const result = parseDyb(page('yto'), YTO, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2024-04-06T10:19:15+08:00',
      delivery_carrier: 'yto', delivery_tracking_number: 'YT2516046414426' });
    const events = result.events!;
    expect(events).toHaveLength(21);
    expect(events[0]).toMatchObject({ location: '江苏省,南京市', description: '【江苏省,南京市】已签收，感谢使用圆通速递，期待再次为您服务！' });
    expect(events[1]).toMatchObject({ stage: 'ready_for_pickup',
      description: '【江苏省,南京市】您好，快件已暂存至南京天都芳庭12栋小平层店菜鸟驿站，感谢使用圆通速递，期待再次为您服务！' });
    expect(events[2]).toMatchObject({ description: '【江苏省南京市建邺区应天】正在派件，请耐心等待！', stage: 'out_for_delivery' });
    expect(events[10]).toMatchObject({ description: '您的快件在【天津市武清区开发区】已揽收', stage: 'in_transit' });
    expect(events.find((event) => event.location === '加拿大多伦多')).toMatchObject({ description: '【加拿大多伦多】仓库已揽收', stage: 'accepted' });
    expect(JSON.stringify(result)).not.toMatch(/某某|13800000000|业务员|电话|签收人|95161/);
  });

  it('leaves out a name given with a phone, a bracket that gives a contact and a clause that names one', () => {
    expect(dybText('【长宁】 的某某（13800000000） 正在第1次派件, 请保持电话畅通,并耐心等待（95720为中通快递员外呼专属号码，请放心接听）'))
      .toBe('【长宁】 正在第1次派件,并耐心等待');
    expect(dybText('【天津东丽南部】（021-00000000） 的 客户某某（13800000000） 已揽收')).toBe('【天津东丽南部】 已揽收');
    expect(dybText('您的快件在【天津市某区】已揽收，揽收人: 某某（13800000000）')).toBe('您的快件在【天津市某区】已揽收');
    expect(dybText('快件已在 【长宁】 签收, 签收人: 某某, 如有疑问请电联:（13800000000）, 您的快递已经妥投。')).toBe('快件已在 【长宁】 签收, 您的快递已经妥投');
    expect(dybText('您的快件离开【南京转运中心】，已发往【江苏省,南京市】')).toBe('您的快件离开【南京转运中心】，已发往【江苏省,南京市】');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseDyb(page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDyb(page('zto'), YTO, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDyb(page('zto').replace('<dt>2022-07-25 13:03:39</dt>', '<dt>2022-07-32 13:03:39</dt>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDyb(page('zto').replace(/<dl class="track-list">[\s\S]*<\/dl>/, '<dl class="track-list"></dl>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseDyb(page('zto').replace('<dl class="track-list">', '<ul>'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A row dated after the lookup keeps its wall clock alone.
    expect(parseDyb(page('zto'), NUMBER, Date.parse('2022-07-25T10:00:00+08:00')).events![0]).not.toHaveProperty('time');
    const lookup = (body: BodyInit, init?: ResponseInit) => new DybTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new DybTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('zto'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.dybservice.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeDybNumber(` ${NUMBER} `)).toBe(NUMBER);
    expect(normalizeDybNumber('dyb-4031 436594867')).toBe('DYB4031436594867');
    for (const number of ['S8200', 'ABCDEFGHIJ', '1'.repeat(31), 'S8200/00186989', '']) {
      expect(() => normalizeDybNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new DybTracker({ fetcher }).fetch('S8200')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new DybTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'dyb-express', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps its own rows and the couriers\' by their wording, whatever place the brackets name', () => {
    expect(dybStage('【温哥华】仓库已揽收')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(dybStage('等待清关')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(dybStage('快件已经到达 【某某中转部】')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage(null, '航班起飞')).toBe('in_transit');
    expect(statusMap.stage('1', '航班起飞')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});

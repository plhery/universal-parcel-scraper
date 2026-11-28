import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GJS_LOOKUP, gjsWording, parseGjs } from './adapter.js';
import { gjsStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const PARCEL = numbers.records[0]!.number;
const UNKNOWN = 'GJS888260399001';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Reply = { code: number; msg: string; data?: { packageNo: string; expressNo: string; trackInfoList: Record<string, unknown>[] } };
const text = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'delivered' | 'not-found') => JSON.parse(text(name)) as Reply;
const parse = (reply: unknown = json('delivered'), number = PARCEL) => parseGjs(reply, number, READ_AT);
const withData = (fields: Record<string, unknown>) => {
  const reply = json('delivered');
  return { ...reply, data: { ...reply.data!, ...fields } };
};

describe('GJS Express', () => {
  it('posts the number to the tracking service through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text('delivered'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'gjsguoji', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.track({ number: PARCEL.toLowerCase() }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(GJS_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ packageNo: null, expressNo: PARCEL });
  });

  it('reads the example newest first, on China\'s clock, without the couriers and phones', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '快件已在[南昌瑶湖]，签收', last_update: '2026-04-05T11:24:35+08:00', last_update_local: '2026-04-05T11:24:35',
      expected_delivery: null, delivery_carrier: 'zto', delivery_tracking_number: '77122354037513' }));
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-04-05T11:24:35', '南昌瑶湖', '快件已在[南昌瑶湖]，签收', 'delivered'],
      ['2026-04-05T11:24:34', '南昌市', '已签收', 'delivered'],
      ['2026-04-05T11:10:32', '南昌市', '快件已被代收', 'ready_for_pickup'],
      ['2026-04-05T08:05:50', '南昌瑶湖', '[南昌瑶湖]的快递员正在派件', 'out_for_delivery'],
      ['2026-04-05T08:05:43', '南昌瑶湖', '快件到达[南昌瑶湖]，网点到件扫描', 'in_transit'],
      ['2026-04-04T23:18:27', '南昌中转部', '快件离开[南昌中转部]发往[南昌瑶湖]，网点发件扫描', 'in_transit'],
      ['2026-04-04T20:38:20', '南昌中转部', '快件到达[南昌中转部]，网点到件扫描', 'in_transit'],
      ['2026-04-03T21:00:39', '石家庄', '快件离开[石家庄]发往[南昌中转部]，网点发件扫描', 'in_transit'],
      ['2026-04-03T20:56:59', '石家庄', '快件到达[石家庄]，网点到件扫描', 'in_transit'],
      ['2026-04-03T17:09:35', '石家庄正定县', '快件离开[石家庄正定县]发往[石家庄]，网点发件扫描', 'in_transit'],
      ['2026-04-03T17:09:30', '石家庄正定县', '[石家庄正定县]业务员已揽收', 'in_transit'],
      ['2026-04-03T09:11:00', '中国', '[中国]进行处理，快件已开始清关', 'customs'],
      ['2026-04-02T09:04:00', '中国国际机场', '快件转运中，请耐心等候', 'in_transit'],
      ['2026-04-01T16:05:00', '中国', '[中国]干线航班落地[中国国际机场]', 'in_transit'],
      ['2026-04-01T09:09:00', '日本', '[日本][东京]干线航班起飞[日本国际机场]', 'in_transit'],
      ['2026-03-31T13:41:19', 'Tokyo, Japan', '清关完成等待航班装载', 'in_transit'],
      ['2026-03-31T13:35:05', 'Tokyo, Japan', '货物到达成田机场保税仓库', 'in_transit'],
      ['2026-03-31T11:36:03', '东京', '[东京][中通国际]进行处理:订单已操作出库', 'in_transit'],
      ['2026-03-30T13:20:53', '东京', '[东京][中通国际]进行处理：订单已操作入库', 'in_transit'],
      ['2026-03-30T13:19:55', 'Tokyo, Japan', '快件仓库已经揽收', 'in_transit'],
      ['2026-03-30T11:42:36', 'Tokyo, Japan', '快件等待仓库揽收', 'in_transit'],
      ['2026-03-28T16:17:21', 'Tokyo, Japan', '快件门店已经揽收', 'accepted'],
      ['2026-03-28T16:03:27', 'Tokyo, Japan', '快件等待揽收', 'registered'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/1[3-9]\d{9}|张三|快递超市|欢猫|签收人|电联|感谢/u);
  });

  it('answers only for the number asked, by its parcel number with or without GJS, or its domestic waybill', () => {
    expect(parse(json('delivered'), '888260301983').events).toHaveLength(23);
    expect(parse(json('delivered'), '77122354037513')).not.toHaveProperty('delivery_carrier');
    expect(() => parse(json('delivered'), 'GJS888260301984')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const foreign = json('delivered');
    foreign.data!.trackInfoList[0] = { ...foreign.data!.trackInfoList[0], packageNo: '888260301984' };
    expect(() => parse(foreign)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withData({ trackInfoList: [] }))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse({ code: 500, msg: '系统繁忙' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ code: 200, msg: '操作成功', data: null })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withData({ trackInfoList: [{ trackingTime: '2026-02-30 10:00:00', trackingContent: '快件等待揽收' }] })))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(json('delivered'), 'GJS-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads a browser check or a firewall refusal as a challenge, and a page that is not JSON as a changed reply', async () => {
    const page = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    for (const [body, status, kind] of [[page, 200, 'challenge'], ['Request blocked.', 403, 'challenge'], ['<html></html>', 200, 'schema']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
      const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
      await expect(instance.track({ number: PARCEL }, { budgetMs: 5000 })).rejects.toMatchObject({ kind });
    }
  });

  it('keeps the place a row starts with and drops the contacts it names', () => {
    expect(gjsWording('Tokyo, Japan  货物到达成田机场保税仓库')).toEqual({ description: '货物到达成田机场保税仓库', location: 'Tokyo, Japan' });
    expect(gjsWording('[上海浦东]业务员[李四][13800000000]已揽收')).toEqual({ description: '[上海浦东]业务员已揽收', location: '上海浦东' });
    expect(gjsWording('快件已在[南昌瑶湖]，签收，签收人[本人]，感谢使用中通快递')).toEqual({ description: '快件已在[南昌瑶湖]，签收', location: '南昌瑶湖' });
    expect(gjsWording('快件派送中，请联系 13800000000')).toEqual({ description: '快件派送中，请联系' });
  });

  it('reads the tracking page\'s links', () => {
    expect(parseTrackingInput(`https://h5.guojisuyunjapan.cn/#/pages/public/trackDetail?expressNo=${PARCEL}`))
      .toMatchObject({ trackingNumber: PARCEL, carrier: 'gjsguoji' });
  });

  it('maps the firm\'s and its partners\' wordings', () => {
    expect(gjsStage('[东京][中通国际]进行处理:订单已操作出库')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(gjsStage('[中国]进行处理，快件已开始清关')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(statusMap.stage(null, '快件已被代收')).toBe('ready_for_pickup');
    expect(statusMap.gaps).toEqual([]);
  });
});

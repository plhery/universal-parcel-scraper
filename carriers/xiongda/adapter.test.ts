import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, XIONGDA_SITE, XiongdaTracker, xiongdaLookupUrl } from './adapter.js';
import { normalizeXiongdaNumber, parseXiongda, xiongdaRemark, xiongdaZone } from './parser.js';
import { statusMap, updateWords, xiongdaStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'XD9999999999';
// After the sample's newest row on any clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
// UPS's documented example, which passes UPS's check digit.
const UPS = '1Z999AA10123456784';
type Fixture = 'delivered' | 'not-found';
const text = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Reply = { success: unknown; code: unknown; data: { event: Record<string, unknown>[] } };
const reply = (name: Fixture = 'delivered'): Reply => JSON.parse(text(name)) as Reply;
const order = (payload: Reply) => payload.data.event[0]!;
type Row = Record<string, unknown>;
const rows = (payload: Reply) => order(payload).eventdetail as Row[];
const body = (payload: unknown) => JSON.stringify(payload);
const response = (content: BodyInit, init: ResponseInit = {}) => new Response(content,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
/** The sample with one row in front, as the newest. */
function withRow(row: Row): Reply {
  const payload = reply();
  rows(payload).unshift({ activity: '', activityEn: '', city: '', code: '9060', country: '', eventDetail: '', eventDetailEn: '',
    eventTime: '2026-10-29 10:00:00', orderNo: NUMBER, referenceNo: '', remark: '', shipmentNo: '', shipmentType: '', visibility: 3, ...row });
  return payload;
}

describe('Xiong Da tracking lookup', () => {
  it('asks the tracking interface for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 2).toLowerCase()} ${NUMBER.slice(2, 8)}-${NUMBER.slice(8)}`;
    const result = await new XiongdaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '妥投 Delivered, DELIVERED' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${XIONGDA_SITE}/ajax/jiekou.aspx?status=chaxunnew&no=${NUMBER}`);
    expect(String(url)).toBe(xiongdaLookupUrl(NUMBER));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xiongda', step: 'direct', outcome: 'ok' }));
  });

  it('reads the waybill newest first, China rows on China\'s clock and the rest on their wall clocks', () => {
    const result = parseXiongda(text('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '妥投 Delivered, DELIVERED', last_update: null, last_update_local: '2026-10-28T16:32:34',
      expected_delivery: null, destination_country: 'US' });
    expect(result.delivery_carrier).toBeUndefined();
    const events = result.events!;
    expect(events).toHaveLength(33);
    expect(events.slice(0, 4)).toEqual([
      { local_time: '2026-10-28T16:32:34', description: '妥投 Delivered, DELIVERED', provider_code: '2115', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2026-10-28T09:22:02', description: '正在派送 Out for Delivery, Out For Delivery Today', provider_code: '9060',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-10-28T05:38:31', description: '正在派送 On the Way, Loaded on Delivery Vehicle', provider_code: '9060',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2026-10-28T05:32:08', description: '正在派送 Processing at UPS Facility', provider_code: '9060',
        stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
    expect(events.slice(15, 25).map((event) => [event.local_time, event.time, event.time_zone, event.time_zone_basis, event.location,
      event.description, event.stage])).toEqual([
      ['2026-10-26T09:11:00', undefined, undefined, undefined, 'US', '运输中 10-26 美国时间，已交付，请关注更新', 'in_transit'],
      ['2026-10-25T12:08:00', undefined, undefined, undefined, "Chicago O'Hare International Airport, US", '到达海外仓 货物提取 奥黑尔国际机场ORD', 'in_transit'],
      ['2026-10-24T05:32:00', undefined, undefined, undefined, undefined, '其他异常 少收货物 奥黑尔国际机场ORD', 'exception'],
      ['2026-10-21T23:37:00', undefined, undefined, undefined, "Chicago O'Hare International Airport, US",
        '进口清关完成 10-21 美国时间，进口清关放行，预计1-3个工作日提货交付', 'in_transit'],
      ['2026-10-21T23:28:00', undefined, undefined, undefined, "Chicago O'Hare International Airport, US", '到达目的机场', 'in_transit'],
      ['2026-10-21T23:18:00', undefined, undefined, undefined, 'US', '到达中转机场 10-21 美国时间，航班已抵达', 'in_transit'],
      ['2026-10-21T22:28:00', '2026-10-21T22:28:00+08:00', 'Asia/Shanghai', 'place', 'Shanghai Pudong International Airport, CN', '离开始发机场', 'in_transit'],
      ['2026-10-21T22:14:00', '2026-10-21T22:14:00+08:00', 'Asia/Shanghai', 'place', 'CN', '离开中转机场 10-21 配载ORD航班已起飞', 'in_transit'],
      ['2026-10-20T21:25:00', '2026-10-20T21:25:00+08:00', 'Asia/Shanghai', 'place', 'Shanghai Pudong International Airport, CN', '出口报关放行', 'in_transit'],
      ['2026-10-19T17:59:40', undefined, undefined, undefined, undefined, '已打托', 'in_transit'],
    ]);
    // The placeholder city 市辖区 and its pinyin leave the country alone.
    expect(events.slice(26, 33).map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-10-19T11:15:48', 'CN', '同行接单', 'accepted'],
      ['2026-10-19T10:51:46', 'CN', 'Ship Track入库', 'accepted'],
      ['2026-10-19T09:24:17', undefined, '已核重', 'accepted'],
      ['2026-10-19T09:24:17', 'CN', '到达国内仓', 'accepted'],
      ['2026-10-18T22:23:13', undefined, '尾程已下单 Label Created, Shipper created a label, UPS has not received the package yet.', 'registered'],
      ['2026-10-17T13:29:20', undefined, '订单审核成功', 'registered'],
      ['2026-10-17T07:24:27', undefined, '订单创建', 'registered'],
    ]);
    expect(events.every((event) => event.provider_code && event.local_time)).toBe(true);
  });

  it('takes a row\'s zone from its country, or a US row\'s from a state of one clock, and keeps any other on its wall clock', () => {
    expect(xiongdaZone('', 'CN')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(xiongdaZone('', 'GB')).toEqual({ zone: 'Europe/London', basis: 'place' });
    expect(xiongdaZone('LOS ANGELES, CA', 'US')).toEqual({ zone: 'America/Los_Angeles', basis: 'place' });
    expect(xiongdaZone('Ontario, CA, US', 'US')).toEqual({ zone: 'America/Los_Angeles', basis: 'place' });
    expect(xiongdaZone('DALLAS, TX', 'US')).toBeNull();
    expect(xiongdaZone("Chicago O'Hare International Airport", 'US')).toBeNull();
    expect(xiongdaZone('', 'US')).toBeNull();
    expect(xiongdaZone('Toronto', 'CA')).toBeNull();
    expect(xiongdaZone('', '')).toBeNull();
    const placed = parseXiongda(body(withRow({ city: 'LOS ANGELES, CA', country: 'US', remark: 'Arrived at Facility' })), NUMBER, READ_AT);
    expect(placed.events![0]).toMatchObject({ time: '2026-10-29T10:00:00-07:00', time_zone: 'America/Los_Angeles', time_zone_basis: 'place',
      local_time: '2026-10-29T10:00:00', location: 'LOS ANGELES, CA, US' });
    expect(placed.last_update).toBe('2026-10-29T10:00:00-07:00');
    // A row the zone would date after the read keeps its wall clock alone.
    const early = parseXiongda(body(withRow({ country: 'CN', eventTime: '2026-11-28 14:00:00', activity: '运输中' })), NUMBER, READ_AT);
    expect(early.events![0]).toEqual({ local_time: '2026-11-28T14:00:00', location: 'CN', description: '运输中', provider_code: '9060',
      stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('hands off to UPS only where the reply names UPS and one valid UPS number', () => {
    const named = withRow({ activity: '正在派送', remark: 'Processing at UPS Facility', shipmentNo: UPS.toLowerCase() });
    expect(parseXiongda(body(named), NUMBER, READ_AT)).toMatchObject({ delivery_carrier: 'ups', delivery_tracking_number: UPS });
    const inNote = withRow({ activity: '尾程已下单', code: '2097', remark: `UPS: ${UPS}` });
    expect(parseXiongda(body(inNote), NUMBER, READ_AT)).toMatchObject({ delivery_carrier: 'ups', delivery_tracking_number: UPS });
    const unnamed = reply();
    for (const row of rows(unnamed)) row.remark = clean(row.remark).replace(/\bUPS\b/g, 'the carrier');
    rows(unnamed)[0]!.shipmentNo = UPS;
    expect(parseXiongda(body(unnamed), NUMBER, READ_AT).delivery_carrier).toBeUndefined();
    const invalid = withRow({ remark: 'Arrived at Facility', shipmentNo: `${UPS.slice(0, 17)}5` });
    expect(parseXiongda(body(invalid), NUMBER, READ_AT).delivery_carrier).toBeUndefined();
    const two = withRow({ remark: 'Arrived at Facility', shipmentNo: UPS, eventDetailEn: 'Also 1Z999AA10987654328' });
    expect(parseXiongda(body(two), NUMBER, READ_AT).delivery_carrier).toBeUndefined();
  });

  it('keeps a note without the signer or a phone it names', () => {
    expect(xiongdaRemark('Delivered, DELIVERED, Signed by: SYNTHETIC NAME')).toBe('Delivered, DELIVERED');
    expect(xiongdaRemark('已签收，签收人：某某')).toBe('已签收');
    expect(xiongdaRemark('请联系 13800000000 预约')).toBe('请联系');
    expect(xiongdaRemark('Call (555) 010-0000 to reschedule')).toBe('Call');
    expect(xiongdaRemark('10-21 美国时间，进口清关放行，预计1-3个工作日提货交付')).toBe('10-21 美国时间，进口清关放行，预计1-3个工作日提货交付');
    const signed = parseXiongda(body(withRow({ code: '2115', activity: '妥投', remark: 'Delivered, DELIVERED, Signed by: SYNTHETIC NAME' })), NUMBER, READ_AT);
    expect(signed.events![0]!.description).toBe('妥投 Delivered, DELIVERED');
    expect(JSON.stringify(signed)).not.toMatch(/SYNTHETIC/);
  });

  it('reads the empty order under the number asked as not found, and anything else as inconclusive', async () => {
    expect(() => parseXiongda(text('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const other = reply('not-found');
    order(other).orderNo = 'XD9999999998';
    expect(() => parseXiongda(body(other), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const failed = reply('not-found');
    failed.success = false;
    expect(() => parseXiongda(body(failed), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const coded = reply('not-found');
    coded.code = '500';
    expect(() => parseXiongda(body(coded), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Rows under another number are inconclusive; under the customer's reference they are the order's.
    expect(() => parseXiongda(text('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const reference = reply();
    order(reference).referenceNo = 'XDREF0000001';
    expect(parseXiongda(body(reference), 'XDREF0000001', READ_AT).current_stage).toBe('delivered');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('not-found')));
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: UNKNOWN }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads a browser check as a challenge, and a changed reply or a refusal as such', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    expect(() => parseXiongda(challenge, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseXiongda('<html><body>Server Error</body></html>', NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXiongda(body({ success: true, code: '0', data: {} }), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const badTime = withRow({ eventTime: '2026-02-30 10:00:00', remark: 'Arrived at Facility' });
    expect(() => parseXiongda(body(badTime), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const run = (init: ResponseInit, content = challenge) => new XiongdaTracker({
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(content, init)) }).fetch(NUMBER, { budgetMs: 5000 });
    await expect(run({ status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(run({ status: 404 }, 'Not Found')).rejects.toMatchObject({ kind: 'transport' });
  });

  it('stages each code, and an update by its words', () => {
    expect(xiongdaStage('1020', '订单创建')).toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(xiongdaStage('2049', '出口报关放行')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(xiongdaStage('9050', '其他异常 少收货物')).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(xiongdaStage('9060', '正在派送 Delivered')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(xiongdaStage('9060', '正在派送 Label Created, Shipper created a label')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(xiongdaStage('9060', '运输中 10-26 美国时间，已交付，请关注更新')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(xiongdaStage('9999', '未知事件')).toBeNull();
    expect(updateWords('正在派送 Arrived at Facility')).toBe('Arrived at Facility');
    expect(statusMap.stage('9060', '正在派送 out for delivery, out for delivery today')).toBe('out_for_delivery');
    expect(statusMap.stage('2115', '妥投 delivered, delivered')).toBe('delivered');
    expect(statusMap.stage(null, '妥投')).toBeUndefined();
  });

  it('rejects input that is not a waybill', () => {
    expect(normalizeXiongdaNumber(' xd-2610 170002 ')).toBe(NUMBER);
    expect(() => normalizeXiongdaNumber('XDXDXDXDXD')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeXiongdaNumber('XD12')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });
});

function clean(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

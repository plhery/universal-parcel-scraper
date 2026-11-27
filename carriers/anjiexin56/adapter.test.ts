import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ANJIEXIN } from './adapter.js';
import { LQFAST_DETAIL, LqfastTracker, lqfastLookupUrl, lqfastWording, normalizeLqfastNumber, parseLqfast } from './lqfast.js';
import { anjiexinStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
// The sample's cargo number (货号), which the portal finds the waybill by too.
const CARGO = '0525-3462-10';
const UNKNOWN = '70318294';
// After the sample's newest row.
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Reply = { Sus: boolean; Data: string | null; Msg: string | null; Data2: string | null; [key: string]: unknown };
type Row = { billdate: string; content: string };
const text = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'delivered' | 'not-found') => JSON.parse(text(name)) as Reply;
// The sample's reply with its rows, or its waybill record, replaced.
const withRows = (rows: readonly Row[]) => ({ ...json('delivered'), Data: JSON.stringify(rows) });
const withRecords = (records: readonly unknown[]) => ({ ...json('delivered'), Data2: JSON.stringify(records) });
const parse = (reply: unknown = json('delivered'), number = NUMBER, readAt = READ_AT) => parseLqfast(reply, number, ANJIEXIN, readAt);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

describe('ANJIEXIN Logistics on Lanqiao\'s waybill portal', () => {
  it('asks the portal for the whole number under the firm\'s company id, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new LqfastTracker(ANJIEXIN, { fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${NUMBER} `, { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lqfastLookupUrl(ANJIEXIN.companyId, NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(LQFAST_DETAIL);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ companyid: 'JNCqnZaL7Kz+bo2dhhXzyQ==', unit: NUMBER, offsetx: '', voffset: '',
      phone: '', contentzf: '' });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init!.headers).not.toHaveProperty('Cookie');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'anjiexin56', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first on China\'s clock, with the place a row starts with as its location', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '货物已签收', last_update: '2023-05-30T16:38:00+08:00', last_update_local: '2023-05-30T16:38:00', expected_delivery: null }));
    const events = result.events!;
    expect(events.map((event) => [event.description, event.location, event.stage])).toEqual([
      ['货物已签收', undefined, 'delivered'],
      ['货物派送中', undefined, 'out_for_delivery'],
      ['货物已到达【重庆分拨中心】/卸货分拣中', undefined, 'in_transit'],
      ['货物由【深圳分拨中心】发往【重庆分拨中心】运输途中', undefined, 'in_transit'],
      ['分流出库', '深圳', 'in_transit'],
      ['开单入库', '深圳', 'accepted'],
    ]);
    expect(events[0]).toEqual({ time: '2023-05-30T16:38:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2023-05-30T16:38:00', description: '货物已签收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events.at(-1)).toEqual({ time: '2023-05-25T21:47:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2023-05-25T21:47:00', location: '深圳', description: '开单入库', stage: 'accepted', stage_source: 'carrier_map' });
    expect(events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
  });

  it('finds the waybill by its cargo number too', () => {
    expect(parse(json('delivered'), CARGO).events).toHaveLength(6);
  });

  it('keeps rows at one clock in the reply\'s order, reads a repeated row once, and leaves a clock after the read its wall clock alone', () => {
    const rows: Row[] = [
      { billdate: '2023-05-30 16:38', content: '货物已签收' },
      { billdate: '2023-05-30 16:38', content: '签收回单' },
      { billdate: '2023-05-30 14:14:00', content: '货物派送中' },
      { billdate: '2023-05-30 14:14:00', content: '货物派送中' },
      { billdate: '2023-05-25 21:47:00', content: '【深圳】' },
    ];
    const result = parse(withRows(rows));
    expect(result.events!.map((event) => [event.local_time, event.description])).toEqual([
      ['2023-05-30T16:38:00', '货物已签收'], ['2023-05-30T16:38:00', '签收回单'], ['2023-05-30T14:14:00', '货物派送中'],
    ]);
    const early = parse(json('delivered'), NUMBER, Date.parse('2023-05-30T07:00:00Z'));
    expect(early.events![0]).toEqual({ local_time: '2023-05-30T16:38:00', description: '货物已签收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(early).toMatchObject({ last_update: null, last_update_local: '2023-05-30T16:38:00' });
  });

  it('keeps no enquiry phone, signer, driver or plate from a row', () => {
    expect(lqfastWording('【北京市】货物正在派送途中【查询电话：0755-00000000/13800000000】')).toEqual({ location: '北京市', description: '货物正在派送途中' });
    expect(lqfastWording('办理提货；签收人【张三】')).toEqual({ description: '办理提货' });
    expect(lqfastWording('【深圳】第1次配载发车；件数:10；车牌号【粤B00000】')).toEqual({ location: '深圳', description: '第1次配载发车；件数:10' });
    expect(lqfastWording('【重庆】第1次送货；件数:10；司机：李四')).toEqual({ location: '重庆', description: '第1次送货；件数:10' });
    expect(lqfastWording('货物已签收，签收人李四')).toEqual({ description: '货物已签收' });
    expect(lqfastWording('货物派送中，请联系 13800000000')).toEqual({ description: '货物派送中，请联系' });
    expect(lqfastWording('货物派送中，电话：0755-00000000')).toEqual({ description: '货物派送中' });
    expect(lqfastWording('收货人已提货')).toEqual({ description: '收货人已提货' });
    const signed = parse(withRows([{ billdate: '2023-05-30 16:38:00', content: '办理提货；签收人【张三】' }]));
    expect(JSON.stringify(signed)).not.toMatch(/张三/);
  });

  it('reads only the portal\'s own answer for an unknown number as not found', async () => {
    expect(() => parse(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const refused = (message: string | null) => ({ ...json('not-found'), Msg: message });
    for (const message of ['解码失败', '请输入手机号后四位', null]) {
      expect(() => parse(refused(message), UNKNOWN), String(message)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
    expect(() => parse({ Data: null, Msg: '未找到运单！' })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse([])).toThrow(expect.objectContaining({ kind: 'schema' }));
    // Another waybill, several, none or one the portal gives without its record.
    expect(() => parse(json('delivered'), '2023463')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withRecords([{ unit: 2023462, billno: CARGO }, { unit: 2023463, billno: '0525-3463-1' }])))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withRecords([]))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withRecords([{ unit: { value: 2023462 } }]))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse({ ...json('delivered'), Data2: null })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse({ ...json('delivered'), Data: null })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse({ ...json('delivered'), Data: '{"rows":[]}' })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withRows([{ billdate: '2023-05-30 24:00:00', content: '货物已签收' }]))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withRows([{ billdate: '2023/05/30 16:38:00', content: '货物已签收' }]))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withRows([]))).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    const lookup = (body: string, init?: ResponseInit) => new LqfastTracker(ANJIEXIN, { fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: '/Pub/Error' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '30' } })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('<html><script>var arg1="acw_sc__v2"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><body>系统维护中</body></html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('accepts letters and digits with a digit, without a request otherwise', async () => {
    expect(normalizeLqfastNumber(CARGO, 'ANJIEXIN Logistics')).toBe('0525346210');
    for (const number of ['2023', 'ANJIEXIN', '2023462/1', '1'.repeat(31)]) {
      expect(() => normalizeLqfastNumber(number, 'ANJIEXIN Logistics'), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new LqfastTracker(ANJIEXIN, { fetcher }).fetch('2023/462')).rejects.toMatchObject({ kind: 'invalid_input' });
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
    expect(instance).toMatchObject({ id: 'anjiexin56', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.recognize!('2023/462', {})).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps the firm\'s wordings, with the varying parts of its templates, and passes over its receipt rows', () => {
    expect(anjiexinStage('开单入库')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(anjiexinStage('货物由【深圳分拨中心】发往【成都分拨中心】运输途中')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(anjiexinStage('第2次配载发车；件数:3')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(anjiexinStage('第1次送货；件数:10')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(anjiexinStage('收到回单')).toBeNull();
    expect(statusMap.stage(null, '货物已签收')).toBe('delivered');
    expect(statusMap.stage(null, '收到回单')).toBeUndefined();
    expect(statusMap.gaps.map((gap) => gap.wording)).toEqual(['签收回单', '寄出回单', '收到回单', '返厂回单']);
    // A receipt row after the signature leaves the parcel delivered.
    const rows = [{ billdate: '2023-06-02 10:00:00', content: '【深圳】收到回单' }, ...JSON.parse(json('delivered').Data!) as Row[]];
    expect(parse(withRows(rows))).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '收到回单' });
  });
});

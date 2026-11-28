import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, BMXPS_API, BmxpsTracker } from './adapter.js';
import { bmxpsText, normalizeBmxpsNumber, parseBmxps } from './parser.js';
import { bmxpsStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'BM9999000001';
type Name = 'delivered' | 'not-found';
type Row = { Message: string; EventTime: string };
type Reply = { result: boolean; message: string | null; data: Row[] | null };
const text = (name: Name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Name) => JSON.parse(text(name)) as Reply;
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });
const withRows = (change: (rows: Row[]) => Row[]): Reply => {
  const payload = json('delivered');
  return { ...payload, data: change(payload.data!) };
};

describe('BMXPS tracking lookup', () => {
  it('posts the whole number to the tracker through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new BmxpsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${NUMBER.slice(0, 4)}-${NUMBER.slice(4)} `.toLowerCase(), { budgetMs: 5000 });
    expect(result.events).toHaveLength(17);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(BMXPS_API);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(init!.body)).toBe(`orderNumber=${NUMBER}`);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bmxps', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first as instants, with SF Express as the courier in China', () => {
    const result = parseBmxps(json('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收(丰巢签收),感谢使用顺丰,期待再次为您服务（主单总件数：1件）', last_update: '2022-03-16T04:22:27Z',
      expected_delivery: null, destination_country: 'CN', delivery_carrier: 'sf-express', delivery_tracking_number: 'SF1344982026394' });
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2022-03-16T04:22:27Z', '已签收(丰巢签收),感谢使用顺丰,期待再次为您服务（主单总件数：1件）', null, 'delivered'],
      ['2022-03-15T23:12:59Z', '快件到达 【广州增城荔城镇营业点】', '广州增城荔城镇营业点', 'in_transit'],
      ['2022-03-15T21:32:34Z', '快件在【广州宝湾5号库集散点】完成分拣,准备发往 【广州增城荔城镇营业点】', '广州宝湾5号库集散点', 'in_transit'],
      ['2022-03-15T19:47:18Z', '快件到达 【广州宝湾5号库集散点】', '广州宝湾5号库集散点', 'in_transit'],
      ['2022-03-15T16:56:28Z', '快件在【江门杜阮中转场】完成分拣,准备发往 【广州新塘中转场】', '江门杜阮中转场', 'in_transit'],
      ['2022-03-15T16:21:42Z', '快件到达 【江门杜阮中转场】', '江门杜阮中转场', 'in_transit'],
      ['2022-03-15T15:35:35Z', '已转【顺丰速递】派送，运单号 SF1344982026394', null, 'in_transit'],
      ['2022-03-15T14:16:28Z', '快件在【江门鹤山元岗新村营业点】完成分拣,准备发往 【江门杜阮中转场】', '江门鹤山元岗新村营业点', 'in_transit'],
      ['2022-03-15T13:16:25Z', '顺丰速运 已收取快件', null, 'in_transit'],
      ['2022-03-15T09:05:57Z', '清关完成', null, 'in_transit'],
      ['2022-03-12T02:55:29Z', '您的货物已经到达中国，正在海关清关', null, 'customs'],
      ['2022-03-01T10:03:13Z', '飞往中国', null, 'in_transit'],
      ['2022-02-25T23:04:49Z', '您的货物在仓库【JF-Baltimore】已经完成集货，转交航空公司', 'JF-Baltimore', 'in_transit'],
      ['2022-02-24T18:43:53Z', '您的货物在仓库【JF-Baltimore】已经完成装箱', 'JF-Baltimore', 'in_transit'],
      ['2022-02-24T14:21:09Z', '您的货物在仓库【JF-Baltimore】正在集货，等待送往机场', 'JF-Baltimore', 'in_transit'],
      ['2022-02-23T19:57:31Z', '您的货物在仓库【JF-Baltimore】已经打包完成', 'JF-Baltimore', 'accepted'],
      ['2022-02-23T18:38:28Z', '您的订单已创建成功', null, 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2022-03-16T04:22:27Z', description: '已签收(丰巢签收),感谢使用顺丰,期待再次为您服务（主单总件数：1件）',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/签收图|签收人信息/);
  });

  it('hands the parcel to the courier the row names only when that courier\'s rules offer the number', () => {
    const handed = (message: string) => parseBmxps(withRows((rows) => rows.map((row) => (row.Message.startsWith('已转')
      ? { ...row, Message: message } : row))), NUMBER);
    expect(handed('已转【顺丰速递】派送，运单号 1234')).not.toHaveProperty('delivery_carrier');
    expect(handed('已转【某某快递】派送，运单号 SF1344982026394')).not.toHaveProperty('delivery_carrier');
    expect(handed('运单号 SF1344982026394')).not.toHaveProperty('delivery_carrier');
    expect(handed('已转【顺丰速递】派送，运单号 SF1344982026394')).toMatchObject({ delivery_carrier: 'sf-express' });
  });

  it('takes couriers, signers and phones out of a relayed row and keeps the waybill', () => {
    expect(bmxpsText('快件交给某人，正在派送途中（联系电话：13800000000）')).toBe('正在派送途中');
    expect(bmxpsText('已签收:某人,感谢使用顺丰')).toBe('已签收感谢使用顺丰');
    expect(bmxpsText('已转【顺丰速递】派送，运单号 SF1344982026394')).toBe('已转【顺丰速递】派送，运单号 SF1344982026394');
    expect(bmxpsText('派件员 某人 13800000000')).toBe('');
  });

  it('reads the tracker\'s unknown-order answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseBmxps(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseBmxps({ result: false, message: '系统繁忙', data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBmxps({ result: false, message: '订单不存在', data: [] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBmxps({ message: '订单不存在' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBmxps({ result: true, message: null, data: null }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBmxps({ result: true, message: null, data: [] }, UNKNOWN)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseBmxps(withRows((rows) => [{ ...rows[0]!, EventTime: '2022-02-23 18:38' }]), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new BmxpsTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(text('not-found'), { status: 500 })).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.bmxps.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><title>北美快运</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeBmxpsNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['BM200', 'BMXPSORDER', `BM${'2'.repeat(30)}`, `${NUMBER},${UNKNOWN}`, '']) {
      expect(() => normalizeBmxpsNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BmxpsTracker({ fetcher }).fetch('BM2000&x=1')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new BmxpsTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'bmxps', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers BMXPS for no number shape', () => {
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).candidates).not.toContain('bmxps');
  });

  it('maps each text in statuses.json, whatever the places and the waybill, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('快件到达 【某地中转场】'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('已转【顺丰速递】派送，运单号 SF1234567890123'))).toBe('in_transit');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(bmxpsStage('已签收,本人签收')).toMatchObject({ stage: 'delivered' });
    expect(bmxpsStage('新的状态')).toBeNull();
  });
});

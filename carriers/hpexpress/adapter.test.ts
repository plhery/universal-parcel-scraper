import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HPEXPRESS_API, HpexpressTracker, hpexpressLookupUrl } from './adapter.js';
import { hpexpressText, normalizeHpexpressNumber, parseHpexpress } from './parser.js';
import { hpexpressStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'HP000000001';
type Name = 'delivered' | 'not-found';
type Row = { context: string; time: number; ftime: number; id: number | null };
type Order = Record<string, unknown> & { domesticTrackingNumber: string; internationalTrackingInfo: Row[];
  clearanceTrackingInfo: Row[]; domesticTrackingInfo: Row[] };
type Reply = { code: number; msg: string; data: Order[]; success: boolean };
const text = (name: Name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Name) => JSON.parse(text(name)) as Reply;
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, ...init });
const withOrder = (change: (order: Order) => Order): Reply => {
  const payload = json('delivered');
  return { ...payload, data: [change(payload.data[0]!)] };
};

describe('HP Express tracking lookup', () => {
  it('asks the service for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new HpexpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${NUMBER.slice(0, 5)}-${NUMBER.slice(5)} `.toLowerCase(), { budgetMs: 5000 });
    expect(result.events).toHaveLength(19);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(HPEXPRESS_API);
    expect(asked.searchParams.get('orderSn')).toBe(NUMBER);
    expect(asked.searchParams.get('_T')).toMatch(/^\d{13}$/);
    expect(hpexpressLookupUrl(NUMBER, 1)).toBe(`${HPEXPRESS_API}?orderSn=${NUMBER}&_T=1`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'target-platform': 'pc', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hpexpress', step: 'direct', outcome: 'ok' }));
  });

  it('reads the three legs of the sample as one history newest first, without the postmen, the signer or the ID-card request', () => {
    const result = parseHpexpress(json('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收,他人代收', last_update: '2020-11-10T07:54:20Z', expected_delivery: null, destination_country: 'CN' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2020-11-10T07:54:20Z', '已签收,他人代收', null, 'delivered'],
      ['2020-11-10T01:25:30Z', '【罗源城关营业部】安排投递', '罗源城关营业部', 'out_for_delivery'],
      ['2020-11-10T01:11:57Z', '到达【罗源城关营业部】', '罗源城关营业部', 'in_transit'],
      ['2020-11-10T01:11:24Z', '离开【罗源城关邮政揽投】,下一站【罗源城关营业部】', '罗源城关邮政揽投', 'in_transit'],
      ['2020-11-09T17:24:05Z', '到达【福州中心局邮件处理中心】', '福州中心局邮件处理中心', 'in_transit'],
      ['2020-11-09T14:18:28Z', '离开【泉州寄递邮政处理中心】,下一站【福州中心局邮件处理中心】', '泉州寄递邮政处理中心', 'in_transit'],
      ['2020-11-09T12:53:33Z', '到达【泉州寄递邮政处理中心】', '泉州寄递邮政处理中心', 'in_transit'],
      ['2020-11-09T12:45:16Z', '离开【晋江跨境快件营业部】,下一站【泉州寄递邮政处理中心】', '晋江跨境快件营业部', 'in_transit'],
      ['2020-11-09T12:41:23Z', '【晋江跨境快件营业部】已收寄', '晋江跨境快件营业部', 'in_transit'],
      ['2020-11-09T08:56:47Z', '【中国快件处理中心】您的包裹已通过海关检验，已放行，转入泉州邮政快递，包裹单号为：9973555647202', '中国快件处理中心', 'in_transit'],
      ['2020-11-09T04:44:13Z', '【中国厦门机场】您的包裹到达泉州口岸，正在清关中', '中国厦门机场', 'customs'],
      ['2020-11-09T01:09:34Z', '【中国厦门机场】您的包裹正在送往泉州口岸', '中国厦门机场', 'in_transit'],
      ['2020-11-08T15:07:12Z', '【中国厦门机场】您的包裹到达中国厦门机场', '中国厦门机场', 'in_transit'],
      ['2020-11-06T07:01:43Z', '【海派中转仓】您的包裹已上飞机，飞往中国（厦门机场）', '海派中转仓', 'in_transit'],
      ['2020-11-04T06:51:33Z', '【海派中转仓】您的快递已转运至机场', '海派中转仓', 'in_transit'],
      ['2020-11-04T00:22:44Z', '【海派中转仓】您的快递已完成分拣', '海派中转仓', 'in_transit'],
      ['2020-11-03T06:17:35Z', '【海派中转仓】包裹已通过信息审核，等待过机查验', '海派中转仓', 'in_transit'],
      ['2020-11-03T06:12:28Z', '【澳大利亚海派】包裹已揽件，等待信息审核', '澳大利亚海派', 'accepted'],
      ['2020-11-03T06:11:05Z', '【澳大利亚中央仓】已将订单导入系统中，等待物流公司揽件', '澳大利亚中央仓', 'registered'],
    ]);
    expect(result.events![0]).toEqual({ time: '2020-11-10T07:54:20Z', description: '已签收,他人代收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/\*|13800000000|13800000001|投递员|揽投员|电话|身份证|idcard|href/);
  });

  it('hands the parcel to the courier the clearance row names only when that courier\'s rules offer the number', () => {
    const handed = (context: string) => parseHpexpress(withOrder((order) => ({ ...order, clearanceTrackingInfo: order.clearanceTrackingInfo
      .map((row, index) => (index === 0 ? { ...row, context } : row)) })), NUMBER);
    expect(handed('【中国快件处理中心】您的包裹已通过海关检验，已放行，转入顺丰速运，包裹单号为：SF1234567890123')).toMatchObject({
      delivery_carrier: 'sf-express', delivery_tracking_number: 'SF1234567890123' });
    expect(detectCarrierMatch('9973555647202').candidates).not.toContain('china-post');
    expect(handed('【中国快件处理中心】您的包裹已通过海关检验，已放行，转入泉州邮政快递，包裹单号为：9973555647202')).not.toHaveProperty('delivery_carrier');
    expect(handed('【中国快件处理中心】您的包裹已通过海关检验，已放行，包裹单号为：SF1234567890123')).not.toHaveProperty('delivery_carrier');
    expect(handed('【中国快件处理中心】已放行，转入顺丰速运，包裹单号为：1234567890')).not.toHaveProperty('delivery_carrier');
  });

  it('takes the postmen, signers, phones and ID-card request out of a text and keeps the courier\'s number', () => {
    expect(hpexpressText('已签收,他人代收：某小区门卫,投递员:某人,电话:13800000000')).toBe('已签收,他人代收');
    expect(hpexpressText('【罗源城关营业部】安排投递,投递员:某人,电话:13800000000,揽投部电话:13800000001')).toBe('【罗源城关营业部】安排投递');
    expect(hpexpressText('【晋江跨境快件营业部】已收寄,揽投员:某人,电话:13800000000')).toBe('【晋江跨境快件营业部】已收寄');
    expect(hpexpressText('【澳大利亚中央仓】已将订单导入系统中，等待物流公司揽件，如尚未上传身份证，请及时上传，点击<a href=\'javascript:;\' class=\'idcardurl\'>上传身份证</a>'))
      .toBe('【澳大利亚中央仓】已将订单导入系统中，等待物流公司揽件');
    expect(hpexpressText('转入泉州邮政快递，包裹单号为：9973555647202')).toBe('转入泉州邮政快递，包裹单号为：9973555647202');
    expect(hpexpressText('派件员 某人 13800000000')).toBe('');
  });

  it('reads the tracker\'s unknown-number answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHpexpress(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const notFound = json('not-found');
    const message = (errorMsg: string) => ({ ...notFound, data: [{ ...notFound.data[0]!, errorMsg }] });
    expect(() => parseHpexpress(message('系统繁忙，请稍后再试'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHpexpress(message('抱歉！未查到此快递单号HP000000002信息，请确认快递单号是否正确。'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHpexpress(notFound, 'HP000000002')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHpexpress({ code: 401, msg: '用户未登录', success: false }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHpexpress({ ...notFound, data: [] }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHpexpress(json('delivered'), 'HP888189117')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHpexpress(withOrder((order) => ({ ...order, internationalTrackingInfo: [], clearanceTrackingInfo: [], domesticTrackingInfo: [] })), NUMBER))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseHpexpress(withOrder((order) => ({ ...order, domesticTrackingInfo: [{ ...order.domesticTrackingInfo[0]!, time: 'soon' as never }] })), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHpexpress({ data: [] }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new HpexpressTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.hpexpress.com.au/index' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!doctype html><html><div id="__nuxt"></div></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeHpexpressNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['HP888', 'HPEXPRESS', `HP${'8'.repeat(30)}`, `${NUMBER},${UNKNOWN}`, '']) {
      expect(() => normalizeHpexpressNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HpexpressTracker({ fetcher }).fetch('HP888&_T=1')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new HpexpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hpexpress', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers HP Express for no number shape', () => {
    for (const record of numbers.records) expect(detectCarrierMatch(record.number).candidates).not.toContain('hpexpress');
  });

  it('maps each text in statuses.json, whatever the places and the hand-off number, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('到达【某地邮件处理中心】'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('【中国快件处理中心】您的包裹已通过海关检验，已放行，转入泉州邮政快递，包裹单号为：1234567890123')))
      .toBe('in_transit');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(hpexpressStage('已签收,本人签收')).toMatchObject({ stage: 'delivered' });
    expect(hpexpressStage('新的状态')).toBeNull();
  });
});

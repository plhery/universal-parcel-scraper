import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { lqfastLookupUrl, parseLqfast } from '../anjiexin56/lqfast.js';
import { adapter, ANNENGYUNTONG } from './adapter.js';
import { annengyuntongStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

// The fixture is Kuaidi100's example waybill; its cargo number is the same digits after ANYT.
const WAYBILL = numbers.records[1]!.number;
const CARGO = `ANYT${WAYBILL}`;
const UNKNOWN = 'ANYT1901010317';
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Reply = { Sus: boolean; Data: string | null; Msg: string | null; Data2: string | null; [key: string]: unknown };
const text = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'delivered' | 'not-found') => JSON.parse(text(name)) as Reply;
const parse = (reply: unknown = json('delivered'), number = WAYBILL) => parseLqfast(reply, number, ANNENGYUNTONG, READ_AT);

describe('Annengyuntong Logistics on Lanqiao\'s waybill portal', () => {
  it('asks the portal under the firm\'s own company id, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text('delivered'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'annengyuntong', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.track({ number: CARGO }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lqfastLookupUrl('9d3suZLQaTTCLeYx7PsD8w==', CARGO));
    expect(new URL(String(url)).searchParams.get('companyid')).toBe('9d3suZLQaTTCLeYx7PsD8w==');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads the example newest first, without the signer or the branch\'s phones', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '办理提货', last_update: '2026-02-06T13:58:41+08:00', last_update_local: '2026-02-06T13:58:41', expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-02-06T13:58:41', undefined, '办理提货', 'delivered'],
      ['2026-02-06T09:22:00', '泸州市', '货物正在派送途中', 'out_for_delivery'],
      ['2026-02-06T07:35:00', '泸州市', '快件到达派送营业点', 'in_transit'],
      ['2026-02-01T08:10:00', '慈溪市', '在途 预计2月6日到达', 'in_transit'],
      ['2026-02-01T02:43:00', '慈溪市', '快件配载发车', 'in_transit'],
      ['2026-01-31T18:52:59', undefined, '分流出库', 'in_transit'],
      ['2026-01-31T16:59:35', undefined, '开单入库', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/张三|0755|13800000000|查询电话|签收人/);
  });

  it('finds the waybill by its waybill or its cargo number, and by nothing else', () => {
    expect(parse(json('delivered'), CARGO).events).toHaveLength(7);
    expect(() => parse(json('delivered'), 'ANYT66602452')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse({ ...json('not-found'), Msg: '解码失败' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('names the firm for its cargo numbers and for portal links under its company id', () => {
    expect(detectCarrierMatch(CARGO)).toMatchObject({ carrier: 'annengyuntong', confidence: 'high' });
    expect(detectCarrierMatch(WAYBILL).carrier).toBe('unknown');
    const page = 'https://wx.lqfast.com/Pub/UnitListDetail?companyid=9d3suZLQaTTCLeYx7PsD8w%3D%3D&unit=';
    const query = 'https://wx.lqfast.com/wx/waybillquery/#/';
    expect(parseTrackingInput(`${page}${WAYBILL}`)).toMatchObject({ trackingNumber: WAYBILL, carrier: 'annengyuntong' });
    expect(parseTrackingInput(`${query}?companyid=9d3suZLQaTTCLeYx7PsD8w%3D%3D&unit=${WAYBILL}`))
      .toMatchObject({ trackingNumber: WAYBILL, carrier: 'annengyuntong' });
    expect(parseTrackingInput(`${query}waybillquery/orderDetail?seek=${WAYBILL}&companyid=9d3suZLQaTTCLeYx7PsD8w%3D%3D`))
      .toMatchObject({ trackingNumber: WAYBILL, carrier: 'annengyuntong' });
    expect(parseTrackingInput(`https://wx.lqfast.com/Pub/UnitListDetail?companyid=JNCqnZaL7Kz%2Bbo2dhhXzyQ%3D%3D&unit=${WAYBILL}`))
      .toMatchObject({ trackingNumber: WAYBILL, carrier: 'anjiexin56' });
    expect(parseTrackingInput(`https://wx.lqfast.com/Pub/UnitListDetail?companyid=AnotherTenant%3D%3D&unit=${WAYBILL}`).carrier)
      .not.toMatch(/annengyuntong|anjiexin56/);
  });

  it('maps the firm\'s wordings and passes over its receipt rows', () => {
    expect(annengyuntongStage('在途 预计12月30日到达')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(annengyuntongStage('转送至【成都中转】')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(annengyuntongStage('签收回单')).toBeNull();
    expect(statusMap.stage(null, '办理提货')).toBe('delivered');
    expect(statusMap.gaps.map((gap) => gap.wording)).toEqual(['签收回单', '寄出回单', '收到回单', '返厂回单']);
  });
});

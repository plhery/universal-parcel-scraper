import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { lqfastLookupUrl, lqfastWording, parseLqfast } from '../anjiexin56/lqfast.js';
import { adapter, XINCHEN } from './adapter.js';
import { statusMap, xinchenStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import numbers from './numbers.json' with { type: 'json' };

// The fixture is Kuaidi100's example waybill.
const WAYBILL = numbers.records[0]!.number;
const UNKNOWN = '1999999999';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Reply = { Sus: boolean; Data: string | null; Msg: string | null; Data2: string | null; [key: string]: unknown };
const text = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'delivered' | 'not-found') => JSON.parse(text(name)) as Reply;
const parse = (reply: unknown = json('delivered'), number = WAYBILL) => parseLqfast(reply, number, XINCHEN, READ_AT);

describe('Xinchen Logistics on Lanqiao\'s waybill portal', () => {
  it('asks the portal under the firm\'s own company id, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text('delivered'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'cdxinchen56', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lqfastLookupUrl('6n09opswzrylt7MBDbTGSg==', WAYBILL));
    expect(new URL(String(url)).searchParams.get('companyid')).toBe('6n09opswzrylt7MBDbTGSg==');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads the example newest first, without the signer', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '货物已提货签收', last_update: '2020-07-04T15:15:00+08:00', last_update_local: '2020-07-04T15:15:00', expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2020-07-04T15:15:00', '货物已提货签收', 'delivered'],
      ['2020-07-04T15:15:00', '已经签收', 'delivered'],
      ['2020-07-04T13:44:49', '已送货', 'out_for_delivery'],
      ['2020-07-04T13:44:24', '货物到达成都', 'in_transit'],
      ['2020-07-03T17:01:32', '从攀枝花一部配载中心发车', 'in_transit'],
      ['2020-07-03T15:46:05', '攀枝花一部(攀一部)已开单入库', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/张三/);
  });

  it('leaves out a signer the platform names between 由 and 签收', () => {
    expect(lqfastWording('已经由张三签收')).toEqual({ description: '已经签收' });
    expect(lqfastWording('货物已由【张三】提货签收')).toEqual({ description: '货物已提货签收' });
    expect(lqfastWording('货物由【深圳分拨中心】发往【重庆分拨中心】运输途中').description).toBe('货物由【深圳分拨中心】发往【重庆分拨中心】运输途中');
  });

  it('finds the waybill by its own number, and reads the portal\'s refusal as not found', () => {
    expect(() => parse(json('delivered'), '3104063')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse({ ...json('not-found'), Msg: '解码失败' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes portal links under its company id only', () => {
    const page = 'https://wx.lqfast.com/Pub/UnitListDetail?companyid=6n09opswzrylt7MBDbTGSg%3D%3D&unit=';
    expect(parseTrackingInput(`${page}${WAYBILL}`)).toMatchObject({ trackingNumber: WAYBILL, carrier: 'cdxinchen56' });
    expect(parseTrackingInput(`https://wx.lqfast.com/Pub/UnitListDetail?companyid=AnotherTenant%3D%3D&unit=${WAYBILL}`).carrier)
      .not.toBe('cdxinchen56');
  });

  it('stages every recorded wording by the map', () => {
    for (const entry of statuses.entries) {
      const wording = entry.wording.replaceAll('…', '西昌');
      expect(xinchenStage(wording)).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMap.stage(null, wording)).toBe(entry.stage);
    }
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { lqfastLookupUrl, parseLqfast } from '../anjiexin56/lqfast.js';
import { adapter, KQTWL } from './adapter.js';
import { kqtwlStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const WAYBILL = numbers.records[0]!.number;
const UNKNOWN = '8020199001';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Reply = { Sus: boolean; Data: string | null; Msg: string | null; Data2: string | null; [key: string]: unknown };
const text = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'delivered' | 'not-found') => JSON.parse(text(name)) as Reply;
const parse = (reply: unknown = json('delivered'), number = WAYBILL) => parseLqfast(reply, number, KQTWL, READ_AT);
// The delivered reply with its record's fields changed.
const withRecord = (fields: Record<string, unknown>) => {
  const reply = json('delivered');
  const [record] = JSON.parse(reply.Data2!) as Record<string, unknown>[];
  return { ...reply, Data2: JSON.stringify([{ ...record, ...fields }]) };
};

describe('Kaiqitong Logistics on Lanqiao\'s waybill portal', () => {
  it('asks the portal under the firm\'s own company id, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text('delivered'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'kqtwl', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lqfastLookupUrl('99HDajcB62Q8ilC47SAc0Q==', WAYBILL));
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads the example newest first, on China\'s clock', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '签收', last_update: '2024-12-09T15:34:53+08:00', last_update_local: '2024-12-09T15:34:53', expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2024-12-09T15:34:53', undefined, '签收', 'delivered'],
      ['2024-12-07T09:16:00', undefined, '到达：玉溪市，预约派送', 'in_transit'],
      ['2024-12-06T10:16:20', undefined, '到达：昆明分拨，下一站：玉溪市', 'in_transit'],
      ['2024-12-05T15:21:35', undefined, '在途：途经百色市右江区G80（广昆高速）路段', 'in_transit'],
      ['2024-12-05T02:47:30', undefined, '发车，已离开深圳分拨', 'in_transit'],
      ['2024-12-05T02:46:04', '深圳', '分流出库', 'in_transit'],
      ['2024-12-05T02:39:09', '深圳', '开单入库', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
  });

  it('answers only for the number asked and the firm\'s own waybill', () => {
    expect(() => parse(json('delivered'), '8020132')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withRecord({ cygsname: '深圳市另一家物流有限公司' }))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parse(withRecord({ cygsname: '' })).events).toHaveLength(7);
    expect(() => parse(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse({ ...json('not-found'), Msg: '解码失败' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ Sus: true, Data: 'not json', Msg: null, Data2: '[]' })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(json('delivered'), 'KQ-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads a browser check in place of the reply as a challenge', async () => {
    const page = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(page, { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reads portal links under the firm\'s company id', () => {
    const page = 'https://wx.lqfast.com/Pub/UnitListDetail?companyid=99HDajcB62Q8ilC47SAc0Q%3D%3D&unit=';
    expect(parseTrackingInput(`${page}${WAYBILL}`)).toMatchObject({ trackingNumber: WAYBILL, carrier: 'kqtwl' });
    expect(parseTrackingInput(`https://wx.lqfast.com/wx/waybillquery/#/?companyid=99HDajcB62Q8ilC47SAc0Q%3D%3D&unit=${WAYBILL}`))
      .toMatchObject({ trackingNumber: WAYBILL, carrier: 'kqtwl' });
    expect(parseTrackingInput(`https://wx.lqfast.com/Pub/UnitListDetail?companyid=AnotherTenant%3D%3D&unit=${WAYBILL}`).carrier).not.toBe('kqtwl');
  });

  it('maps the firm\'s wordings', () => {
    expect(kqtwlStage('到达：昆明分拨，下一站：玉溪市')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(kqtwlStage('签收')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(statusMap.stage(null, '开单入库')).toBe('accepted');
    expect(statusMap.gaps).toEqual([]);
  });
});

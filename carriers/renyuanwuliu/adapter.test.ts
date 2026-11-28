import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { lqfastLookupUrl, parseLqfast } from '../anjiexin56/lqfast.js';
import { adapter, RENYUANWULIU } from './adapter.js';
import { renyuanwuliuStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const WAYBILL = numbers.records[0]!.number;
const UNKNOWN = '6613899001';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Reply = { Sus: boolean; Data: string | null; Msg: string | null; Data2: string | null; [key: string]: unknown };
const text = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'delivered' | 'not-found') => JSON.parse(text(name)) as Reply;
const parse = (reply: unknown = json('delivered'), number = WAYBILL) => parseLqfast(reply, number, RENYUANWULIU, READ_AT);
// The delivered reply with its record's fields changed.
const withRecord = (fields: Record<string, unknown>) => {
  const reply = json('delivered');
  const [record] = JSON.parse(reply.Data2!) as Record<string, unknown>[];
  return { ...reply, Data2: JSON.stringify([{ ...record, ...fields }]) };
};

describe('Renyuan Logistics on Lanqiao\'s waybill portal', () => {
  it('asks the portal under the firm\'s own company id, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text('delivered'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'renyuanwuliu', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(lqfastLookupUrl('AKVKpwhKcTmYqx3ELFLB2g==', WAYBILL));
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads the example newest first, without the signer or the truck\'s plate', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收', last_update: '2025-03-21T16:31:09+08:00', last_update_local: '2025-03-21T16:31:09', expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2025-03-21T16:31:09', undefined, '已签收', 'delivered'],
      ['2025-02-14T10:58:00', undefined, '货物已签收', 'delivered'],
      ['2025-02-13T08:53:00', undefined, '货物到达合肥', 'in_transit'],
      ['2025-02-12T00:12:00', '深圳', '第1次配载发车；件数:516', 'in_transit'],
      ['2025-02-11T20:20:00', '深圳', '开单入库', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/签收人|本人|车牌|皖A/);
  });

  it('answers only for the number asked and the firm\'s own waybill', () => {
    expect(parse(json('delivered'), '6613810516').events).toHaveLength(5);
    expect(() => parse(json('delivered'), '6613811')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(withRecord({ cygsname: '深圳市另一家物流有限公司' }))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse({ ...json('not-found'), Msg: '解码失败' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ Sus: true, Data: 'not json', Msg: null, Data2: '[]' })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(json('delivered'), 'RY-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads a browser check in place of the reply as a challenge', async () => {
    const page = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(page, { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reads portal links under the firm\'s company id', () => {
    expect(parseTrackingInput(`https://wx.lqfast.com/Pub/UnitListDetail?companyid=AKVKpwhKcTmYqx3ELFLB2g%3D%3D&unit=${WAYBILL}`))
      .toMatchObject({ trackingNumber: WAYBILL, carrier: 'renyuanwuliu' });
    expect(parseTrackingInput(`https://wx.lqfast.com/wx/waybillquery/#/?companyid=AKVKpwhKcTmYqx3ELFLB2g==&unit=${WAYBILL}`))
      .toMatchObject({ trackingNumber: WAYBILL, carrier: 'renyuanwuliu' });
  });

  it('maps the firm\'s wordings', () => {
    expect(renyuanwuliuStage('第2次配载发车；件数:12')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(renyuanwuliuStage('货物到达合肥')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage(null, '货物已签收')).toBe('delivered');
    expect(statusMap.gaps).toEqual([]);
  });
});

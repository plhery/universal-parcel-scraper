import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, parseXydwl, xydwlText } from './adapter.js';
import { statusMap, xydwlStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const WAYBILL = numbers.records[0]!.number;
const UNKNOWN = '8098551';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const body = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (name: 'delivered' | 'not-found' = 'delivered') => JSON.parse(body(name)) as { code: number; list: Record<string, Record<string, unknown>[]> };
const parse = (payload: unknown = reply(), number = WAYBILL) => parseXydwl(payload, number, READ_AT);

describe('Xinyuda Logistics tracking service', () => {
  it('posts the number to the result page\'s service, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body('delivered'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'xydwl', steps: ['direct', 'retry'], recordsSteps: true });
    expect(instance.recognize).toBeUndefined();
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://112.74.160.148:8086/glkj/customerservice/customerservicetrack/getOutSideTracks');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ waybillCode: WAYBILL }), signal: expect.any(AbortSignal),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads the example newest first, on China\'s clock, without the signer', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '货物已被签收，感谢您使用鑫宇达物流', last_update: '2024-04-26T08:36:34+08:00', last_update_local: '2024-04-26T08:36:34',
      expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.provider_code, event.description, event.stage])).toEqual([
      ['2024-04-26T08:36:34', 'TRACK_DD_QS', '货物已被签收，感谢您使用鑫宇达物流', 'delivered'],
      ['2024-04-26T08:36:25', 'TRACK_LJ', '运单已生成，等待配载', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map' && event.location === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('广州');
  });

  it('keeps people and phones out of a row', () => {
    expect(xydwlText('货物已被【某某】签收，感谢您使用鑫宇达物流；')).toBe('货物已被签收，感谢您使用鑫宇达物流');
    expect(xydwlText('货物已发车，司机：某某，电话：13800000000')).toBe('货物已发车');
    expect(xydwlText('货物已到达，请联系 0755-12345678 提货')).toBe('货物已到达，请联系');
  });

  it('stages a template it does not know by its wording, or leaves it open', () => {
    expect(xydwlStage('TRACK_LJ', '')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(xydwlStage('TRACK_XX', '某某')).toBeNull();
    expect(statusMap.stage('TRACK_DD_QS', '')).toBe('delivered');
    expect(statusMap.stage(null, '运单已生成，等待配载')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });

  it('answers only for the number asked', () => {
    expect(() => parse(reply(), '8008558')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(reply('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const strayRow = reply();
    strayRow.list[WAYBILL]![0]!.waybillNo = '8008558';
    expect(() => parse(strayRow)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(reply(), 'XY-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads a waybill listed without rows as listed without history', () => {
    expect(() => parse({ msg: 'success', code: 0, list: { [WAYBILL]: [] } })).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('reads a failed lookup as inconclusive, a changed reply as one, and a browser check as a challenge', async () => {
    expect(() => parse({ msg: 'error', code: 500 })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ msg: 'success', code: 0, list: [] })).toThrow(expect.objectContaining({ kind: 'schema' }));
    const badClock = reply();
    badClock.list[WAYBILL]![1]!.trackTime = '2024-04-31 08:36:25';
    expect(() => parse(badClock)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const check = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(check, { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('keeps a row clocked after the read to its wall clock', () => {
    const result = parseXydwl(reply(), WAYBILL, Date.parse('2024-04-26T00:30:00Z'));
    expect(result.events![0]).toMatchObject({ local_time: '2024-04-26T08:36:34' });
    expect(result.events![0]!.time).toBeUndefined();
    expect(result.last_update).toBeNull();
  });
});

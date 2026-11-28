import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, parseSzhst56, szhst56Row } from './adapter.js';
import { statusMap, szhst56Stage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const WAYBILL = numbers.records[0]!.number;
const UNKNOWN = '9281593';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const page = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const parse = (html = page('delivered'), number = WAYBILL) => parseSzhst56(html, number, READ_AT);

describe('Hongshuntong Logistics tracking page', () => {
  it('asks the site\'s tracking page for the number, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(page('delivered'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'szhst56', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.szhst56.com/tracking.php?s=${WAYBILL}`);
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads the example newest first, on China\'s clock, without the consignee', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '己和收货人核实下午己签收', last_update: '2023-12-30T17:35:36+08:00', last_update_local: '2023-12-30T17:35:36',
      expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2023-12-30T17:35:36', undefined, '己和收货人核实下午己签收', 'delivered'],
      ['2023-12-30T11:29:52', undefined, '正在派送中', 'out_for_delivery'],
      ['2023-12-30T09:24:18', undefined, '己和收货人联系好今天派送', 'in_transit'],
      ['2023-12-29T11:03:18', '石狮分拨中心', '货物己到石狮分拨中心，正在卸货', 'in_transit'],
      ['2023-12-27T05:12:27', undefined, '货物己发车，下一站石狮分拨中心', 'in_transit'],
      ['2023-12-26T19:00:37', '石岩网点', '目的地：石狮市，11件，货物由石岩网点开单入库', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('某某');
  });

  it('keeps people and phones out of a row', () => {
    expect(szhst56Row('货物己到石狮分拨中心，司机：某某，电话：13800000000').description).toBe('货物己到石狮分拨中心');
    expect(szhst56Row('正在派送中，请保持电话畅通 13800000000').description).toBe('正在派送中，请保持电话畅通');
  });

  it('answers only for the number asked', () => {
    expect(() => parse(page('delivered'), '9201509')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(page('not-found'), '9281594')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(page('delivered'), 'HS-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads a waybill headed without rows as listed without history', () => {
    const bare = page('delivered').replace(/<ul class="look_list">[\s\S]*?<\/ul>/, '');
    expect(() => parse(bare)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('reads a changed page as a changed reply, and a browser check as a challenge', async () => {
    expect(() => parse('<html><body>维护中</body></html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const badClock = page('delivered').replace('2023-12-29 11:03:18', '2023-12-32 11:03:18');
    expect(() => parse(badClock)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const check = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(check, { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('reads tracking page links', () => {
    expect(parseTrackingInput(`https://www.szhst56.com/tracking.php?s=${WAYBILL}`)).toMatchObject({ trackingNumber: WAYBILL, carrier: 'szhst56' });
  });

  it('maps the firm\'s wordings', () => {
    expect(szhst56Stage('货物己发车，下一站石狮分拨中心')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage(null, '正在派送中')).toBe('out_for_delivery');
    expect(statusMap.gaps).toEqual([]);
  });
});

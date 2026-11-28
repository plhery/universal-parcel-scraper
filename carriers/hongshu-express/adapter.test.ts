import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HONGSHU_LOOKUP, HONGSHU_SITE, HongshuTracker } from './adapter.js';
import { normalizeHongshuNumber, parseHongshu } from './parser.js';
import { hongshuStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'H3999999';
// After the sample's newest row.
const READ_AT = Date.parse('2026-11-26T12:00:00Z');
const raw = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('HongShu Express tracking lookup', () => {
  it('posts the whole waybill to the tracking form through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 1).toLowerCase()} ${NUMBER.slice(1, 4)}-${NUMBER.slice(4)}`;
    const result = await new HongshuTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(HONGSHU_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Referer: HONGSHU_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(Object.fromEntries(new URLSearchParams(String(init!.body)))).toEqual({ transactionid: NUMBER });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hongshu-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, each row on its own clock, without the recipient or the courier', () => {
    const result = parseHongshu(raw('delivered'), NUMBER, READ_AT);
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '经客户同意，快件已放', last_update: '2024-08-25T10:51:00+08:00', last_update_local: '2024-08-25T10:51',
      expected_delivery: null, delivery_carrier: 'sf-express' }));
    expect(result).not.toHaveProperty('delivery_tracking_number');
    const events = result.events!;
    expect(events).toHaveLength(24);
    expect(events[0]).toEqual({ time: '2024-08-25T10:51:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'place',
      local_time: '2024-08-25T10:51', location: '西安市', description: '经客户同意，快件已放', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[1]).toMatchObject({ location: '西安市', description: '快件交给，正在派送途中', stage: 'out_for_delivery' });
    expect(events[2]).not.toHaveProperty('stage');
    expect(events[3]).toMatchObject({ description: '快件到达 【西安未央太和路店】', stage: 'in_transit' });
    expect(events[15]).toMatchObject({ location: '赤峰市', description: '顺丰速运 已收取快件', stage: 'in_transit' });
    // The hand-entered milestones at midnight keep their day alone; the one with its hour is on China's clock.
    expect(events.slice(16, 23).map((event) => [event.local_time, event.time, event.stage])).toEqual([
      ['2024-08-20', undefined, 'customs'], ['2024-08-19', undefined, 'customs'], ['2024-08-18T23:00', '2024-08-18T23:00:00+08:00', 'in_transit'],
      ['2024-08-13', undefined, 'in_transit'], ['2024-08-11', undefined, 'in_transit'], ['2024-08-10', undefined, 'in_transit'],
      ['2024-08-01T11:04', '2024-08-01T11:04:00-04:00', 'accepted']]);
    expect(events.at(-1)).toEqual({ time: '2024-08-01T11:02:00-04:00', time_zone: 'America/Toronto', time_zone_basis: 'carrier',
      local_time: '2024-08-01T11:02', description: '货单上传', stage: 'registered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/某某|张三|13800000000|门卫|电话|如有|主单总件数|收件人/);
  });

  it('leaves out a row dated after the lookup', () => {
    const result = parseHongshu(raw('delivered'), NUMBER, Date.parse('2024-08-25T08:00:00+08:00'));
    expect(result).toMatchObject({ last_status_text: '快件交给，正在派送途中', current_stage: 'out_for_delivery' });
  });

  it('names SF Express only when the bar names SF', () => {
    const other = parseHongshu(changed(/顺丰\s*<\/div>/, 'EMS </div>'), NUMBER, READ_AT);
    expect(other).not.toHaveProperty('delivery_carrier');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHongshu(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHongshu(raw('delivered'), 'H3105061', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHongshu(changed(/2024-08-22\s+19:04/, '2024-08-32 19:04'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHongshu(changed(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A page with two waybills, or none and no unknown answer, is a changed page.
    const bar = /<div class="titlebar">[\s\S]*?<\/table>/.exec(raw('delivered'))![0];
    expect(() => parseHongshu(changed(bar, `${bar}${bar}`), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHongshu(raw('not-found').replace('货单不存在', '系统维护中'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new HongshuTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(raw('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://hexpress.ca/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeHongshuNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['H', 'H310506', 'H31050600', 'X3105060', 'H31/5060', '']) {
      expect(() => normalizeHongshuNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HongshuTracker({ fetcher }).fetch('H')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new HongshuTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hongshu-express', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the rows by their sentence, whatever facility the brackets name', () => {
    expect(hongshuStage('快件在【上海转运中心】完成分拣，准备发往 【南京转运中心】')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(hongshuStage('【中国】货物进入清关中')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(hongshuStage('我们正在为您的快件分配最合适的快递员，请您稍等')).toBeNull();
    expect(statusMap.stage(null, '快件到达 【西安汉唐中转场】')).toBe('in_transit');
    expect(statusMap.stage('1', '快件到达 【西安汉唐中转场】')).toBeUndefined();
    expect(statusMap.gaps).toHaveLength(1);
  });
});

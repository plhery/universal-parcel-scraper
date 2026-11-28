import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HUAXINTAI } from './adapter.js';
import { kepponLookupUrl, kepponWording, parseKeppon } from './keppon.js';
import { huaxintaiStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const WAYBILL = numbers.records[0]!.number;
const UNKNOWN = '982731';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const page = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const parse = (html = page('delivered'), number = WAYBILL) => parseKeppon(html, number, HUAXINTAI, READ_AT);

describe('Huaxintai Logistics on its Keppon tracking page', () => {
  it('asks the firm\'s page under its tenant id, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(page('delivered'), { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER, userAgent: 'SyntheticHost/1.0' } as never);
    expect(instance).toMatchObject({ id: 'huaxintai', steps: ['direct', 'retry'], recordsSteps: true });
    expect(instance.recognize).toBeUndefined();
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`http://se.keppon.cn:8057/OnlineTrack.aspx?cid=3356&yid=${WAYBILL}`);
    expect(String(url)).toBe(kepponLookupUrl(HUAXINTAI, WAYBILL));
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
  });

  it('reads the example newest first, on China\'s clock, without the signer', () => {
    const result = parse();
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收', last_update: '2026-05-11T16:05:11+08:00', last_update_local: '2026-05-11T16:05:11', expected_delivery: null }));
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-05-11T16:05:11', undefined, '已签收', 'delivered'],
      ['2026-05-11T08:03:22', '长沙市', '湖南省 长沙市', 'in_transit'],
      ['2026-05-09T10:03:06', undefined, '在途中', 'in_transit'],
      ['2026-05-08T16:01:00', '沈阳市', '已装车', 'in_transit'],
      ['2026-05-07T08:44:39', '沈阳营业部', '系统已开单,进入【沈阳营业部】仓库,准备发往下一站', 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'carrier'
      && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('某某');
  });

  it('keeps people and phones out of a row', () => {
    expect(kepponWording('已签收,签收人【某某】')).toEqual({ description: '已签收' });
    expect(kepponWording('【长沙市】,已到达，司机：某某，电话13800000000')).toEqual({ location: '长沙市', description: '已到达' });
    expect(kepponWording('【】,在途中')).toEqual({ description: '在途中' });
  });

  it('answers only for the number asked', () => {
    expect(() => parse(page('delivered'), '273728')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const otherDetail = page('delivered').replace(`<strong style="text-align: left;">${WAYBILL}</strong>`, '<strong style="text-align: left;">273728</strong>');
    expect(() => parse(otherDetail)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse(page('delivered'), 'HX-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads a waybill listed without rows as listed without history', () => {
    const bare = page('delivered').replace(/<p class="p_click">[\s\S]*?<\/p>/, '');
    expect(() => parse(bare)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('reads a changed page as a changed reply, and a browser check as a challenge', async () => {
    expect(() => parse('<html><body>维护中</body></html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const badClock = page('delivered').replace('2026/5/8 16:01:00', '2026/13/8 16:01:00');
    expect(() => parse(badClock)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const check = '<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(check, { status: 200 }));
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
    await expect(instance.track({ number: WAYBILL }, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps the firm\'s wordings', () => {
    expect(huaxintaiStage('系统已开单,进入【沈阳营业部】仓库,准备发往下一站')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(huaxintaiStage('湖南省 长沙市')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage(null, '已签收')).toBe('delivered');
    expect(statusMap.gaps).toEqual([]);
  });
});

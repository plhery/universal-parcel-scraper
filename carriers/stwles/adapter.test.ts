import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { adapter, normalizeStwlesNumber, parseStwles, STWLES_TRACK, StwlesTracker, stwlesText } from './adapter.js';
import { statusMap, stwlesStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const RECENT = numbers.records[1]!.number;
const UNKNOWN = '5011599999';
// After the samples' newest rows, on China's clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'delivered' | 'recent' | 'not-found';
const page = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' }, ...init });

describe('Shengtai Logistics tracking lookup', () => {
  it('posts the whole order number to the tracking page through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 4)} ${NUMBER.slice(4, 7)}-${NUMBER.slice(7)}`;
    const result = await new StwlesTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(STWLES_TRACK);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `cwb=${NUMBER}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'stwles', step: 'direct', outcome: 'ok' }));
  });

  it('reads the test number on China\'s clock, the station\'s check leaving the delivery standing', () => {
    const result = parseStwles(page('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '货物已由[杭州站]审核', last_update: '2023-06-06T19:26:12+08:00', last_update_local: '2023-06-06T19:26:12',
      expected_delivery: null });
    const events = result.events!;
    expect(events.map((event) => event.description)).toEqual(['货物已由[杭州站]审核', '货物已由[杭州站]反馈为[配送成功]',
      '货物已从[杭州站]分站领货', '从[杭州站]到错货入库', '从[上海分拨中心]出库；下一站[杭州分拨中心]', '从[上海分拨中心]入库',
      '从[上海分拨中心]提货', '从[分拨中心]导入数据']);
    expect(events.map((event) => event.stage)).toEqual([undefined, 'delivered', 'out_for_delivery', 'in_transit', 'in_transit',
      'in_transit', 'accepted', 'registered']);
    expect(events[1]).toEqual({ time: '2023-06-06T19:26:03+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2023-06-06T19:26:03', location: '杭州站', description: '货物已由[杭州站]反馈为[配送成功]', stage: 'delivered',
      stage_source: 'carrier_map' });
    // The import row names no hub.
    expect(events.at(-1)).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/13800000000|电话|供货商|百度|备注|小件员|管理员/);
  });

  it('reads the recent example the same way', () => {
    const result = parseStwles(page('recent'), RECENT, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-07-20T19:04:05+08:00' });
    expect(result.events).toHaveLength(7);
    expect(result.events![4]).toMatchObject({ location: '深圳分拨中心', description: '从[深圳分拨中心]出库；下一站[兰州站]', stage: 'in_transit' });
  });

  it('leaves out the courier, the supplier, phones, remarks and fields nobody filled', () => {
    expect(stwlesText('货物已从<font color ="red">[兰州站]</font>的小件员<font color ="red">[某某]</font>分站领货；小件员电话：<font color ="red">[13800000000]</font>'))
      .toBe('货物已从[兰州站]分站领货');
    expect(stwlesText('从<font color ="red">[上海分拨中心]</font>提货；供货商：<font color ="red">[某某]</font>；联系电话：<font color ="red">[13800000000]</font>；备注：<font color ="red">[某某代收，13800000000]</font>'))
      .toBe('从[上海分拨中心]提货');
    expect(stwlesText('货物已由<font color ="red">[兰州站]</font>的小件员<font color ="red">[某某]</font>反馈为<font color ="red">[滞留]</font>；备注<font color ="red">[]</font>；再次配送时间：<font color="red">[2026-07-21]</font>;未刷卡原因：<font color="red">[]</font>'))
      .toBe('货物已由[兰州站]反馈为[滞留]；再次配送时间：[2026-07-21]');
    expect(stwlesText('货物已由<font color ="red">[杭州站]</font>的<font color ="red">[某某]</font>审核；联系电话：<font color ="red">[13800000000]</font>'))
      .toBe('货物已由[杭州站]审核');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseStwles(page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseStwles(page('delivered'), RECENT, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseStwles(page('not-found').replace('无此订单！', '系统繁忙'), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseStwles(page('delivered').replace('2023-06-06 19:26:12', '2023-06-31 19:26:12'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseStwles(page('delivered').replace('操作人', '经办人'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const heading = page('delivered').indexOf('</tr>', page('delivered').indexOf('操作过程')) + '</tr>'.length;
    expect(() => parseStwles(`${page('delivered').slice(0, heading)}</table></td></tr></table></div></td></tr></table></body></html>`, NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    // A row dated after the lookup keeps its wall clock alone.
    expect(parseStwles(page('delivered'), NUMBER, Date.parse('2023-06-06T18:00:00+08:00')).events![0]).not.toHaveProperty('time');
    const lookup = (body: BodyInit, init?: ResponseInit) => new StwlesTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new StwlesTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.stwles.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts an order number shape only, without a request', async () => {
    expect(normalizeStwlesNumber(` ${NUMBER} `)).toBe(NUMBER);
    for (const number of ['50115', 'ABCDEFGHIJ', '1'.repeat(31), '5011/518736', '']) {
      expect(() => normalizeStwlesNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new StwlesTracker({ fetcher }).fetch('50115')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new StwlesTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'stwles', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps each sentence by its wording, whatever station the brackets name, and passes over the check', () => {
    expect(stwlesStage('从[北京分拨中心]出库；下一站[天津站]')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(stwlesStage('货物已由[天津站]反馈为[配送成功]')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(stwlesStage('货物已由[天津站]审核')).toBeNull();
    expect(statusMap.stage(null, '从[天津站]到货')).toBe('in_transit');
    expect(statusMap.gapNote?.(null, '货物已由[天津站]审核')).toMatch(/keeps the stage/);
    expect(statusMap.gapNote?.(null, '从[天津站]到货')).toBeUndefined();
    const events = parseStwles(page('recent'), RECENT, READ_AT).events!;
    expect(leadingScan(events, statusMap)).toBe(events[1]);
  });
});

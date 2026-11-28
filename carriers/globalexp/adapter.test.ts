import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GLOBALEXP_SITE, GlobalexpTracker, globalexpLookupUrl } from './adapter.js';
import { normalizeGlobalexpNumber, parseGlobalexp } from './parser.js';
import { globalexpStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'GX999999999999JY';
// After the sample's newest row, on Hong Kong's clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'delivered' | 'not-found';
const html = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const changed = (from: string | RegExp, to: string) => html('delivered').replace(from, to);
// ZTO's waybill the hand-off row names.
const ZTO = /单号：(\d+)/.exec(html('delivered'))![1]!;
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
// Anything of the people, phones and pickup points ZTO's sentences name.
const PERSONAL = /某|1[3-9]\d{9}|\d{3,4}-\d{7,8}|95\d{3}|驿站|取件地址|快递员【|联系|电话|热线|无需找/u;

describe('Global Express tracking lookup', () => {
  it('asks the order page for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(html('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 2).toLowerCase()} ${NUMBER.slice(2, 8)}-${NUMBER.slice(8)}`;
    const result = await new GlobalexpTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '您的快件已妥投，已在代收点取出' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GLOBALEXP_SITE}/search_kuai_di/search/orderid/${NUMBER}`);
    expect(String(url)).toBe(globalexpLookupUrl(NUMBER));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Accept-Language': 'zh-CN', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'globalexp', step: 'direct', outcome: 'ok' }));
  });

  it('reads the order newest first on Hong Kong\'s clock, with ZTO as the delivery carrier', () => {
    const result = parseGlobalexp(html('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已妥投，已在代收点取出', last_update: '2026-11-20T13:19:38+08:00', last_update_local: '2026-11-20T13:19:38',
      expected_delivery: null, destination_country: 'CN', delivery_carrier: 'zto', delivery_tracking_number: ZTO });
    const events = result.events!;
    expect(events.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-11-20T13:19:38', undefined, '您的快件已妥投，已在代收点取出', 'delivered'],
      ['2026-11-12T08:40:44', undefined, '快件已送达，请及时取件', 'ready_for_pickup'],
      ['2026-11-12T08:40:39', undefined, '广州荔城 快递员正在为您派件', 'out_for_delivery'],
      ['2026-11-12T07:06:07', '广州市', '快件已到达 广州荔城', 'in_transit'],
      ['2026-11-12T04:13:25', '广州市', '快件已发往 广州荔城', 'in_transit'],
      ['2026-11-12T03:56:31', '广州市', '快件已到达 广州转运中心', 'in_transit'],
      ['2026-11-11T21:45:49', '广州市', '快件已发往 广州转运中心', 'in_transit'],
      ['2026-11-11T21:39:32', '广州市', '快件已揽收', 'accepted'],
      ['2026-11-11T16:19:26', '广州国际函运中心', `【广州国际函运中心】分拣完成，转国内中通快递，单号：${ZTO}`, 'in_transit'],
      ['2026-11-11T12:40:00', '广州口岸', '【广州口岸】包裹清关完成，进入国内运输环节', 'in_transit'],
      ['2026-11-11T09:37:14', '广州', '到达：【中国 - 广州】国际干线运输已到达【广州】，等待清关', 'customs'],
      ['2026-11-11T02:10:40', '香港', '到达：【中国香港地区 - 香港】，国际干线运输已从【香港】启程', 'in_transit'],
      ['2026-11-10T23:13:48', '香港', '【中国香港地区 - 香港】包裹已从【香港新界海外仓】出库，等待干线运输', 'in_transit'],
      ['2026-11-10T22:13:29', '香港', '【中国香港地区 - 香港】包裹已到达【香港新界海外仓】', 'in_transit'],
      ['2026-11-10T20:06:03', '中国香港新界九龙湾分部', '中国香港新界九龙湾分部 已揽收', 'accepted'],
    ]);
    expect(events[0]).toEqual({ time: '2026-11-20T13:19:38+08:00', time_zone: 'Asia/Hong_Kong', time_zone_basis: 'carrier',
      local_time: '2026-11-20T13:19:38', description: '您的快件已妥投，已在代收点取出', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events.every((event) => event.time_zone === 'Asia/Hong_Kong' && event.time_zone_basis === 'carrier'
      && event.time === `${event.local_time}+08:00` && event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
  });

  it('names ZTO only for a number its rules take, ZTO Freight for its own, and nobody without the hand-off row', () => {
    const handoff = (to: string) => changed(`转国内中通快递，单号：${ZTO}`, to);
    expect(parseGlobalexp(handoff('转国内中通快递，单号：12345678'), NUMBER, READ_AT)).not.toHaveProperty('delivery_carrier');
    expect(parseGlobalexp(handoff('转国内中通快运，单号：12345678'), NUMBER, READ_AT)).not.toHaveProperty('delivery_carrier');
    const none = parseGlobalexp(handoff('分拣完成'), NUMBER, READ_AT);
    expect(none).not.toHaveProperty('delivery_carrier');
    expect(none).not.toHaveProperty('destination_country');
  });

  it('keeps a row dated after the lookup on its wall clock alone', () => {
    const early = parseGlobalexp(html('delivered'), NUMBER, Date.parse('2026-11-15T12:00:00+08:00'));
    expect(early.events![0]).toEqual({ local_time: '2026-11-20T13:19:38', description: '您的快件已妥投，已在代收点取出',
      stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('reads the site\'s notice as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseGlobalexp(html('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGlobalexp(html('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGlobalexp(html('not-found').replace('未查询到对应订单', '请求错误'), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGlobalexp(changed('<th>快件状态</th>', '<th>状态</th>'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlobalexp(changed(/<section class="am-panel[\s\S]*<\/section>/, '<p>维护中</p>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlobalexp(changed('<td>2026-11-11 12:40:00</td>', '<td>2026-11-31 12:40:00</td>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlobalexp(changed(/<tbody>[\s\S]*<\/tbody>/, '<tbody></tbody>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseGlobalexp(changed(/<section class="am-panel[\s\S]*<\/section>/, ''), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new GlobalexpTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(new GlobalexpTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(html('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(html('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: `${GLOBALEXP_SITE}/` } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts an order shape only, without a request', async () => {
    expect(normalizeGlobalexpNumber(` ${NUMBER} `)).toBe(NUMBER);
    expect(normalizeGlobalexpNumber('cy-0000 0000 0000 00')).toBe('CY00000000000000');
    for (const number of ['GX12345', 'ABCDEFGHIJ', '1'.repeat(31), 'GX0033/64354335JY', '']) {
      expect(() => normalizeGlobalexpNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new GlobalexpTracker({ fetcher }).fetch('GX12345')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new GlobalexpTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'globalexp', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the firm\'s and ZTO\'s sentences, whatever place they name', () => {
    expect(globalexpStage('【深圳口岸】包裹清关完成，进入国内运输环节')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(globalexpStage('到达：【中国 - 深圳】国际干线运输已到达【深圳】，等待清关')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(globalexpStage('深圳园山 快递员正在为您派件')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(statusMap.stage(null, '快件已发往 深圳转运中心')).toBe('in_transit');
    expect(statusMap.stage(null, '快件到达')).toBeUndefined();
    expect(statusMap.stage('1', '快件已揽收')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});

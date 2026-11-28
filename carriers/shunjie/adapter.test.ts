import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DsyTracker, dsyLookupUrl, parseDsy, SHUNJIE } from './adapter.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = '300158204736';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
const page = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Passerby A Express tracking lookup', () => {
  it('asks the tenant\'s search for the number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered')));
    const result = await new DsyTracker(SHUNJIE, { fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER, { budgetMs: 5000 });
    expect(result.events).toHaveLength(29);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(dsyLookupUrl(SHUNJIE, NUMBER));
    expect(String(url)).toBe(`https://www.passerbyaexpress.com/index.php?c=index&f=search&sn=${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'shunjie', steps: ['direct', 'retry'] });
  });

  it('reads the warehouse\'s and SF Express\'s rows on China\'s clock and hands the parcel to SF Express', () => {
    const result = parseDsy(SHUNJIE, page('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已派送至本人', last_update: '2026-11-01T12:42:49+08:00', delivered_at: '2026-11-01T12:42:49+08:00',
      origin_country: 'US', destination_country: 'CN', delivery_carrier: 'sf-express', delivery_tracking_number: 'SF5140433575617' });
    const events = result.events!;
    expect(events.slice(0, 3).map((event) => [event.description, event.stage])).toEqual([
      ['您的快件已派送至本人', 'delivered'], ['快件正在派送途中', 'out_for_delivery'], ['快件到达 【沈阳苏家屯加工厂店】', 'in_transit'],
    ]);
    expect(events.find((event) => event.description === '清关中，请耐心等待')).toEqual({ time: '2026-10-29T23:36:12+08:00',
      time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier', local_time: '2026-10-29T23:36:12', description: '清关中，请耐心等待',
      stage: 'customs', stage_source: 'carrier_map' });
    expect(events.at(-1)).toMatchObject({ time: '2026-10-16T09:31:56+08:00', description: '待处理', stage: 'registered' });
    expect(events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/某|13800000000|地址|电话|您的体验|您的期待/);
  });

  it('reads the tips page as not found and the page asking for a number as inconclusive', async () => {
    expect(() => parseDsy(SHUNJIE, page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const asked = page('not-found').replace('运单信息不存在', '请填写运单号查询');
    expect(() => parseDsy(SHUNJIE, asked, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found')));
    await expect(new DsyTracker(SHUNJIE, { fetcher }).fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('leaves twelve bare digits to explicit selection', () => {
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('shunjie');
  });

  it('maps each text by its form in statuses.json', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('快件到达 【北京顺义集散中心】'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('车辆正在长途运输中，车辆临近【石家庄市】，距离下一站约【88】KM，请您放心'))).toBe('in_transit');
  });
});

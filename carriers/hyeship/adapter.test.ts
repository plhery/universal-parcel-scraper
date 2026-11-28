import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HYESHIP_API, HYESHIP_SITE, HyeshipTracker, hyeshipLookupUrl } from './adapter.js';
import { hyeshipPlace, hyeshipRow, hyeshipZone, normalizeHyeshipNumber, parseHyeship } from './parser.js';
import { hyeshipStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
const UNKNOWN = 'ZZ999999990US';
// After the sample's newest row, on Shanghai's clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'delivered' | 'not-found';
const bytes = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));
// The server answers in GBK.
const raw = (name: Fixture) => new TextDecoder('gb18030').decode(bytes(name));
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('Hongyuan Express tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport, and reads its GBK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${SAMPLE.slice(0, 2).toLowerCase()} ${SAMPLE.slice(2, 7)}-${SAMPLE.slice(7)}`;
    const result = await new HyeshipTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '已签收' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(hyeshipLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(HYESHIP_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: SAMPLE });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: HYESHIP_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hyeship', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the warehouse\'s days as days and dates the domestic courier\'s rows on China\'s clock', () => {
    const result = parseHyeship(raw('delivered'), SAMPLE, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收', last_update: '2018-11-04T12:43:00+08:00', last_update_local: '2018-11-04T12:43',
      expected_delivery: null, destination_country: 'CN', weight_kg: 1.8 });
    expect(result).not.toHaveProperty('delivery_carrier');
    const events = result.events!;
    expect(events.map((event) => [event.time ?? null, event.time_zone_basis ?? null, event.local_time, event.location ?? null, event.description, event.stage])).toEqual([
      ['2018-11-04T12:43:00+08:00', 'destination', '2018-11-04T12:43', null, '已签收', 'delivered'],
      ['2018-11-04T07:33:00+08:00', 'destination', '2018-11-04T07:33', null, '到达： 寄存点 指定派送', 'out_for_delivery'],
      ['2018-11-04T07:13:00+08:00', 'destination', '2018-11-04T07:13', null, '到达： 寄存点 上级站点： 吉林主城区公司长春宽城区庆丰服务部', 'in_transit'],
      ['2018-11-04T04:39:00+08:00', 'destination', '2018-11-04T04:39', '吉林长春分拨中心', '到达： 吉林长春分拨中心 发往： 吉林主城区公司长春宽城区庆丰服务部', 'in_transit'],
      ['2018-11-04T04:39:00+08:00', 'destination', '2018-11-04T04:39', '吉林长春分拨中心', '到达： 吉林长春分拨中心', 'in_transit'],
      ['2018-11-04T04:31:00+08:00', 'destination', '2018-11-04T04:31', '吉林长春分拨中心', '到达： 吉林长春分拨中心 上级站点： 鸿远转运中心公司', 'in_transit'],
      ['2018-11-01T08:21:00+08:00', 'destination', '2018-11-01T08:21', '鸿远转运中心龙王庙便民一KH分部', '到达： 鸿远转运中心公司龙王庙便民一KH分部 已揽件', 'in_transit'],
      ['2018-11-01T00:01:00+08:00', 'destination', '2018-11-01T00:01', '鸿远转运中心', '到达： 鸿远转运中心公司 发往： 吉林长春分拨中心', 'in_transit'],
      ['2018-10-31T23:58:00+08:00', 'destination', '2018-10-31T23:58', '鸿远转运中心', '到达： 鸿远转运中心公司 大包称重', 'in_transit'],
      ['2018-10-31T21:33:00+08:00', 'destination', '2018-10-31T21:33', '鸿远包裹分拣中心', '到达： 鸿远转运中心公司宝安区福永环宇集包分部 大包称重', 'in_transit'],
      ['2018-10-31T21:24:00+08:00', 'destination', '2018-10-31T21:24', '鸿远包裹分拣中心', '到达： 鸿远转运中心公司宝安区福永环宇集包分部 发往： 吉林长春网点包', 'in_transit'],
      ['2018-10-31T21:15:00+08:00', 'destination', '2018-10-31T21:15', '鸿远包裹分拣中心', '到达： 鸿远转运中心公司宝安区福永环宇集包分部 已揽件', 'in_transit'],
      [null, null, '2018-10-26', '中国China', '货物今天达到中国海关，进入清关流程 (The package is awaiting China Customs clearing agency review)', 'customs'],
      [null, null, '2018-10-19', '鸿远发货仓库', '货物已发出，发往目的地', 'in_transit'],
      [null, null, '2018-10-17', '鸿远仓库', '货物已入库', 'accepted'],
    ]);
    // Neither the courier, the mobile, who signed nor the pickup point's name reaches the result.
    expect(JSON.stringify(result)).not.toMatch(/某某|13800000000|代签收|联系/u);
  });

  it('leaves out the courier, the phones and the signer, and keeps only a pickup point\'s kind', () => {
    expect(hyeshipRow('到达： 某某服务部某某路驿站 指定：某某(13800000000)派送')).toEqual({ description: '到达： 驿站 指定派送' });
    expect(hyeshipRow('到达： 某某服务部 指定：某某（021-12345678）派送')).toEqual({ description: '到达： 某某服务部 指定派送' });
    expect(hyeshipRow('已签收 : 由 某某。(某某 ) 代签收，如有问题联系某某(13800000000)')).toEqual({ description: '已签收' });
    expect(hyeshipRow('到达： 吉林长春分拨中心 发往：')).toEqual({ description: '到达： 吉林长春分拨中心' });
    expect(hyeshipRow('货物已入库')).toEqual({ description: '货物已入库' });
    expect(hyeshipPlace('某某服务部某某街寄存点')).toBe('');
    expect(hyeshipPlace('某某快递柜')).toBe('');
    expect(hyeshipPlace('吉林长春分拨中心')).toBe('吉林长春分拨中心');
  });

  it('dates a row on Pacific time or China\'s clock by what it says, and leaves one that says neither on its wall clock', () => {
    expect(hyeshipZone('鸿远仓库', '货物已入库')).toEqual({ zone: 'America/Los_Angeles', basis: 'carrier' });
    expect(hyeshipZone('鸿远发货仓库', '货物已发出，发往目的地')).toEqual({ zone: 'America/Los_Angeles', basis: 'carrier' });
    expect(hyeshipZone('中国China', '货物今天达到中国海关，进入清关流程')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(hyeshipZone('吉林长春分拨中心', '到达： 吉林长春分拨中心')).toEqual({ zone: 'Asia/Shanghai', basis: 'destination' });
    expect(hyeshipZone('', '已签收 : 由 某某 代签收')).toEqual({ zone: 'Asia/Shanghai', basis: 'destination' });
    expect(hyeshipZone('鸿远包裹分拣中心', '包裹已出库')).toBeNull();
    const timed = parseHyeship(changed('<DATETIME>2018-10-19</DATETIME>', '<DATETIME>2018-10-19 16:20</DATETIME>'), SAMPLE, READ_AT).events!
      .find((event) => event.description === '货物已发出，发往目的地');
    expect(timed).toMatchObject({ time: '2018-10-19T16:20:00-07:00', time_zone: 'America/Los_Angeles', time_zone_basis: 'carrier' });
    const unzoned = parseHyeship(changed('<INFO>到达： 鸿远转运中心公司 大包称重</INFO>', '<INFO>包裹已出库</INFO>'), SAMPLE, READ_AT).events!
      .find((event) => event.description === '包裹已出库');
    expect(unzoned).toEqual({ local_time: '2018-10-31T23:58', location: '鸿远转运中心', description: '包裹已出库' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHyeship(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHyeship(raw('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHyeship(changed(/^100/, '-1'), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHyeship(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), SAMPLE, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new HyeshipTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(SAMPLE, { budgetMs: 5000 });
    await expect(new HyeshipTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: 'https://www.hyeship.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeHyeshipNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    for (const number of ['LB6030', 'ABCDEFGHIJ', '1'.repeat(31), 'LB603088290US/1', '']) {
      expect(() => normalizeHyeshipNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HyeshipTracker({ fetcher }).fetch('LB6030')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new HyeshipTracker({ fetcher }).fetch(SAMPLE, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hyeship', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps every wording in statuses.json', () => {
    for (const entry of statuses.entries) expect(hyeshipStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    expect(hyeshipStage('到达： 某某分拨中心 发往： 某某服务部')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(hyeshipStage('到达： 驿站 指定派送')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(statusMap.stage('1', '货物已入库')).toBeUndefined();
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});

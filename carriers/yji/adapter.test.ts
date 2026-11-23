import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YjiTracker } from './adapter.js';
import { parseYjiPage, parseYjiTrack, splitYjiRow, YJI_ORIGIN } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };
import carrier from './carrier.json' with { type: 'json' };

const NUMBER = 'YJIDB1836638923YQ';
const UNKNOWN = 'YJIDB0000000001YQ';
// The lookup's moment, after the delivery.
const READ_AT = Date.parse('2026-11-23T00:00:00Z');
type Reply = ReturnType<typeof JSON.parse>;
const fixture = (name: string): Reply => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
const html = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
const environment = (fetcher: typeof fetch) => ({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('YJI tracking adapter', () => {
  it('asks its own Hualei tracker for the whole number over plain HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(fixture('track')));
    await expect(new YjiTracker({ fetcher, recorder: NOOP_RECORDER }).fetch(NUMBER.toLowerCase())).resolves.toMatchObject({
      current_stage: 'delivered', last_update: '2026-04-17T13:28:51-05:00',
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${YJI_ORIGIN}/selectTrack.htm?documentCode=${NUMBER}`);
    expect(YJI_ORIGIN).toBe('http://yanjin-gj.com:8082');
    expect(init).toMatchObject({ method: 'GET', signal: expect.any(AbortSignal) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(adapter(environment(fetcher))).toMatchObject({ id: 'yji', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads its own rows on Beijing time and the FedEx rows it copies in their state’s zone', () => {
    const result = parseYjiTrack(fixture('track'), NUMBER, READ_AT)!;
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_update: '2026-04-17T13:28:51-05:00',
      service_name: '美国限时达海派', destination_country: 'US',
    });
    expect(result.events!.map(({ time, local_time, time_zone_basis, description, location, provider_code, stage }) =>
      [time ?? local_time, time_zone_basis, description, location, provider_code, stage])).toEqual([
      ['2026-04-17T13:28:51-05:00', 'place', '已送达,放在前门处。 不要求签收服务。', 'Cordova, TN', undefined, 'delivered'],
      ['2026-04-17T06:04:00-05:00', 'place', '已装上 FedEx 车辆等待递送', 'MEMPHIS, TN', undefined, 'out_for_delivery'],
      ['2026-04-17T06:00:00-05:00', 'place', '抵达当地 FedEx 服务站', 'MEMPHIS, TN', undefined, 'in_transit'],
      ['2026-04-17T04:06:09-05:00', 'place', '已离开 FedEx 服务站', 'OLIVE BRANCH, MS', undefined, 'in_transit'],
      ['2026-04-17T02:03:00-05:00', 'place', '抵达 FedEx 服务站', 'OLIVE BRANCH, MS', undefined, 'in_transit'],
      ['2026-04-16T12:16:00-05:00', 'place', '途中', 'NORMAN, OK', undefined, 'in_transit'],
      ['2026-04-15T23:16:00-06:00', 'place', '途中', 'BLUEWATER, NM', undefined, 'in_transit'],
      ['2026-04-15T08:38:30-07:00', 'place', '已离开 FedEx 服务站', 'CHINO, CA', undefined, 'in_transit'],
      ['2026-04-14T16:07:19-07:00', 'place', '货件将准时送达', 'CHINO, CA', undefined, 'in_transit'],
      ['2026-04-14T16:05:00-07:00', 'place', '抵达 FedEx 服务站', 'CHINO, CA', undefined, 'in_transit'],
      ['2026-04-14T12:19:00-07:00', 'place', '已收取', 'CHINO, CA', undefined, 'in_transit'],
      ['2026-04-14T10:32:02+08:00', undefined, '【US】您的订单已交服务商，请留意提取信息！', undefined, undefined, 'in_transit'],
      ['2026-04-14T09:12:58+08:00', undefined, '【US】您的订单已提柜，等待拆柜', undefined, undefined, 'in_transit'],
      ['2026-04-10T09:13:40+08:00', undefined, '【US】您的订单已到港，等待清关卸船', undefined, undefined, 'in_transit'],
      ['2026-03-25T11:57:16+08:00', undefined, '【CN】您的订单已开船，船期预计4.9到港', undefined, undefined, 'in_transit'],
      ['2026-03-23T15:56:34+08:00', undefined, '【CN】您的订单预计3.25开船，4.9到港，船名航次：HANSA DUBURG/2603E', undefined, undefined, 'in_transit'],
      ['2026-03-21T11:46:49+08:00', undefined, '货物离开操作中心', '广州', 'SHIPMENT', 'in_transit'],
      ['2026-03-21T11:46:40+08:00', undefined, 'CHINA, GUANGZHOU, ARRIVAL AT OUTWARD OFFICE OF EXCHANGE', '广州', 'ARRIVAL', 'accepted'],
      // FedEx's label row names no state, so it keeps its wall clock alone.
      ['2026-03-21T00:25:00', undefined, '货件信息已发送给 FedEx', 'US', undefined, 'registered'],
      ['2026-03-18T10:42:35+08:00', undefined, '货物电子信息已经收到', undefined, undefined, 'registered'],
    ]);
    // The platform's script, written at once on its own timetable, is named, not kept as scans.
    expect(result.planned_events!.map((event) => event.description)).toEqual(['过机扫描入库(广州设备)', '运单已确认', '计划配载', '完成配载', '已开船', '运输中..']);
    expect(result.written_ahead).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain('SAMPLE');
  });

  it('writes a copied row’s US place as its town and state', () => {
    expect(splitYjiRow('途中', 'US,OK,NORMAN')).toEqual({ content: '途中', location: 'NORMAN, OK' });
    expect(splitYjiRow('货件信息已发送给 FedEx', 'US')).toEqual({ content: '货件信息已发送给 FedEx', location: 'US' });
    expect(splitYjiRow('货物离开操作中心', '广州')).toEqual({ content: '货物离开操作中心', location: '广州' });
  });

  it('reads the page’s unknown-number answer as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture('no-track'))).mockResolvedValueOnce(html(page('page-unknown')));
    await expect(adapter(environment(fetcher)).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${YJI_ORIGIN}/trackIndex.htm`);
    expect(() => parseYjiPage(page('page-unknown'), UNKNOWN, READ_AT)).toThrow('could not locate');
  });

  it('maps every wording it lists, and the app reads the map', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('CHINA, YIWU, ARRIVAL AT OUTWARD OFFICE OF EXCHANGE'))).toBe('accepted');
    expect(statusMap.stage(null, normalizeStatusWording('已送达,放在后门处。'))).toBe('delivered');
    expect(statusMapAnswer({ carrier: 'yji', providerCode: 'SHIPMENT', description: '货物离开操作中心' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(carrier.portal).not.toHaveProperty('url');
    expect(carrier.links).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GLOBAL99_PAGE, Global99Tracker, global99LookupUrl } from './adapter.js';
import { global99Text, normalizeGlobal99Number, parseGlobal99 } from './parser.js';
import { global99Stage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const BALI = numbers.records[0]!.number;
const PARIS = numbers.records[1]!.number;
const UNKNOWN = 'TK000158203947';
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Name = 'bali' | 'paris' | 'not-found';
const page = (name: Name) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html;charset=utf-8' }, ...init });

describe('Global Courier International tracking lookup', () => {
  it('asks the page for the whole number through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('paris')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const typed = `${PARIS.slice(0, 6).toLowerCase()} ${PARIS.slice(6)}`;
    const result = await new Global99Tracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(typed, { budgetMs: 5000 });
    expect(result.events).toHaveLength(20);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(global99LookupUrl(PARIS));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(GLOBAL99_PAGE);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ act: 'search', tid: '56', ydh: PARIS });
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'global99', step: 'direct', outcome: 'ok' }));
  });

  it('dates the Paris branch\'s rows on their places\' clocks and ZTO Express\'s on China\'s, newest first', () => {
    const result = parseGlobal99(page('paris'), PARIS, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已由【家门口】 收取', last_update: '2026-10-27T12:51:47+08:00', last_update_local: '2026-10-27T12:51:47',
      delivered_at: '2026-10-27T12:51:47+08:00', expected_delivery: null, origin_country: 'FR', destination_country: 'CN',
      delivery_carrier: 'zto', delivery_tracking_number: '79040387804339' });
    const events = result.events!;
    expect(events.slice(0, 3).map((event) => [event.description, event.location ?? null, event.stage])).toEqual([
      ['您的快件已由【家门口】 收取', null, 'delivered'], ['大华国贸 正在为您派件', '大华国贸', 'out_for_delivery'],
      ['【上海市】 快件已到达 大华国贸', '上海市', 'in_transit'],
    ]);
    expect(events[0]).toEqual({ time: '2026-10-27T12:51:47+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'destination',
      local_time: '2026-10-27T12:51:47', description: '您的快件已由【家门口】 收取', stage: 'delivered', stage_source: 'carrier_map' });
    // The hand-off row carries no place: a consumer dates it by the rows around it.
    expect(events.find((event) => event.description!.startsWith('转国内'))).toEqual({ local_time: '2026-10-25T18:10:09',
      description: '转国内中通快递，单号：79040387804339', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events.at(-1)).toEqual({ time: '2026-10-18T10:37:28+02:00', time_zone: 'Europe/Paris', time_zone_basis: 'place',
      local_time: '2026-10-18T10:37:28', location: 'PARIS - FRANCE', description: '全球速运 法国巴黎分公司已收件',
      original_description: '全球速运 法国巴黎分公司已收件 PARIS - FRANCE', stage: 'accepted', stage_source: 'carrier_map' });
    expect(events.filter((event) => event.location === 'LEIPZIG - GERMANY').map((event) => [event.time, event.stage])).toEqual([
      ['2026-10-19T08:59:14+02:00', 'in_transit'], ['2026-10-18T23:02:18+02:00', 'customs'], ['2026-10-18T22:03:43+02:00', 'in_transit'],
    ]);
    expect(events.find((event) => event.description === '快件等待清关')).toMatchObject({ time: '2026-10-21T10:05:47+08:00',
      location: 'EAST CHINA AREA - CHINA, PEOPLES REPUBLIC', stage: 'customs' });
    expect(JSON.stringify(result)).not.toMatch(/\*|13800000000|021-|电话|快递员|热线|95720/);
  });

  it('dates the Bali branch on Bali\'s clock and hands the parcel to ZTO Freight under its waybill', () => {
    const result = parseGlobal99(page('bali'), BALI, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', last_status_text: '您的快件已被【本人】【签收】', origin_country: 'ID',
      destination_country: 'CN', delivery_carrier: 'zto-freight', delivery_tracking_number: '301446449949' });
    const events = result.events!;
    expect(events).toHaveLength(22);
    expect(events.slice(0, 3).map((event) => [event.description, event.location ?? null, event.stage])).toEqual([
      ['您的快件已被【本人】【签收】', null, 'delivered'], ['【兴安盟】正在派送中', '兴安盟', 'out_for_delivery'],
      ['快件已到达【兴安盟】', '兴安盟', 'in_transit'],
    ]);
    expect(events.at(-1)).toEqual({ time: '2025-05-22T01:29:49+08:00', time_zone: 'Asia/Makassar', time_zone_basis: 'place',
      local_time: '2025-05-22T01:29:49', location: 'Bali, Indonesia', description: '【Bali Island】巴厘岛分公司已受理取件',
      stage: 'registered', stage_source: 'carrier_map' });
    expect(events.find((event) => event.description === '到达【中国-上海港口】')).toMatchObject({ location: 'SHANGHAI - CHINA',
      time: '2025-06-12T18:20:41+08:00', original_description: '到达【中国-上海港口】SHANGHAI - CHINA]' });
    expect(events.find((event) => event.description === '已安排提货清关，请耐心等待')).toEqual({ local_time: '2025-06-13T14:08:16',
      description: '已安排提货清关，请耐心等待', original_description: '已安排提货清关，请耐心等待 PEOPLES REPUBLIC', stage: 'customs',
      stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/\*|13800000000|致电|业务员|热线|95708/);
  });

  it('takes the courier, phones, hotlines and the courtesy after them out of a row\'s text', () => {
    expect(global99Text('【兴安盟】的业务员 【*** 13800000000】正在派送中，猜您比较着急已在为您加急派送，致电【13800000000】')).toBe('【兴安盟】正在派送中');
    expect(global99Text('【上海市】 快件已由江桥二部***（13800000000）揽收（如遇问题请致电【客服热线：021-00000000】）')).toBe('【上海市】 快件已揽收');
    expect(global99Text('大华国贸 快递员【***,13800000000】正在为您派件（95720为中通快递员外呼专属号码）')).toBe('大华国贸 正在为您派件');
    expect(global99Text('快件已到达【兴安盟】，物流问题致电（13800000000），或官方热线95708')).toBe('快件已到达【兴安盟】');
    expect(global99Text('快件已到达乌兰浩特分部（0482-0000000）某某（13800000000）')).toBe('快件已到达乌兰浩特分部');
    expect(global99Text('【乌兰浩特分部】某某（13800000000）已揽收')).toBe('【乌兰浩特分部】已揽收');
    expect(global99Text('派送异常，请致电 0571-88888888 预约')).toBe('派送异常');
    expect(global99Text('请致电 13800000000')).toBe('请致电');
    expect(global99Text('转国内中通快递，单号：79040387804339')).toBe('转国内中通快递，单号：79040387804339');
  });

  it('names no delivery carrier for a hand-off number that is not that courier\'s', () => {
    const body = page('paris').replace('单号：79040387804339', '单号：AB12345678');
    const result = parseGlobal99(body, PARIS, READ_AT);
    expect(result).toMatchObject({ destination_country: 'CN' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseGlobal99(page('paris'), PARIS, Date.parse('2026-10-27T04:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2026-10-27T07:43:31+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-10-27T12:51:47' });
  });

  it('reads the page\'s alert for the number as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseGlobal99(page('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGlobal99(page('not-found'), PARIS, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlobal99(page('paris'), BALI, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGlobal99(page('not-found').replace(/<script>alert[^<]*<\/script>/u, ''), UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const empty = page('paris').replace(/<tbody>[\s\S]*<\/tbody>/u, '<tbody></tbody>');
    expect(() => parseGlobal99(empty, PARIS, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = page('paris').replace('2026-10-27 12:51:47', '2026-02-30 12:51:47');
    expect(() => parseGlobal99(clock, PARIS, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new Global99Tracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(page('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(page('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(page('not-found'), { status: 500 })).rejects.not.toMatchObject({ kind: 'not_found' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.global-99.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"error":"busy"}', { headers: { 'content-type': 'application/json' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeGlobal99Number(PARIS.toLowerCase())).toBe(PARIS);
    for (const number of ['12345', 'TKABCDEFGH', `T${'1'.repeat(30)}`, 'TK5002/61017008', '']) {
      expect(() => normalizeGlobal99Number(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new Global99Tracker({ fetcher }).fetch('TK1&act=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new Global99Tracker({ fetcher }).fetch(PARIS, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'global99', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers the firm, among others, for TK and twelve digits only', () => {
    expect(detectCarrierMatch(PARIS).candidates).toContain('global99');
    expect(detectCarrierMatch(`${PARIS}1`).candidates).not.toContain('global99');
  });

  it('maps each text by its form in statuses.json, with brackets, numbers and stations as …, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('【北京市】 快件已到达 北京转运中心'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('转国内中通快递，单号：75000000000001'))).toBe('in_transit');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(global99Stage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(global99Stage('新的状态')).toBeNull();
  });
});

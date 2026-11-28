import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ESOWAY_API, ESOWAY_SITE, EsowayTracker, esowayLookupUrl } from './adapter.js';
import { esowayOnward, esowayPlace, esowayRow, esowayZone, normalizeEsowayNumber, parseEsoway } from './parser.js';
import { esowayStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const LOCKER = numbers.records[0]!.number;
const DELIVERED = numbers.records[1]!.number;
const UNKNOWN = 'ES9999999999CA';
// After the samples' newest rows, on Shanghai's clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'locker' | 'delivered' | 'not-found';
const bytes = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));
// The server answers in GBK.
const raw = (name: Fixture) => new TextDecoder('gb18030').decode(bytes(name));
const changed = (from: string | RegExp, to: string) => raw('locker').replace(from, to);
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });
// The ZTO waybill each sample's record names.
const zto = (name: Fixture) => /<REFER_NBR>(\d+)<\/REFER_NBR>/.exec(raw(name))![1]!;
// Anything of the people, phones and pickup spots ZTO's sentences name.
const PERSONAL = /某|1[3-9]\d{9}|\d{3,4}-\d{7,8}|95\d{3}|签收人|业务员【|快递员【|取件地址|联系|电话|热线|丰巢柜|代收点电话/u;

describe('ESOWAY tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport, and reads its GBK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('locker')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${LOCKER.slice(0, 2).toLowerCase()} ${LOCKER.slice(2, 8)}-${LOCKER.slice(8)}`;
    const result = await new EsowayTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '您的快递已签收' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(esowayLookupUrl(LOCKER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(ESOWAY_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: LOCKER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: ESOWAY_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'esoway', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel left in a locker: Vancouver rows on Pacific time, China rows on China\'s, ZTO as the delivery carrier', () => {
    const result = parseEsoway(raw('locker'), LOCKER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快递已签收', last_update: '2024-10-04T11:51:00+08:00', last_update_local: '2024-10-04T11:51',
      expected_delivery: null, weight_kg: 1.15, delivery_carrier: 'zto', delivery_tracking_number: zto('locker') });
    // The destination is a Chinese province, not a country.
    expect(result).not.toHaveProperty('destination_country');
    const events = result.events!;
    expect(events.map((event) => [event.time, event.location, event.description, event.stage])).toEqual([
      ['2024-10-04T11:51:00+08:00', '沈阳市', '您的快递已签收', 'delivered'],
      ['2024-10-02T17:12:00+08:00', '沈阳市', '快件已在 丰巢暂放，请及时取件', 'ready_for_pickup'],
      ['2024-10-02T15:03:00+08:00', '沈阳长白二部', '沈阳长白二部 的业务员正在为您派件', 'out_for_delivery'],
      ['2024-10-02T14:39:00+08:00', '沈阳长白二部', '快件已到达 沈阳长白二部', 'in_transit'],
      ['2024-10-02T09:32:00+08:00', '沈阳转运中心', '快件已发往 沈阳长白二部', 'in_transit'],
      ['2024-10-02T09:27:00+08:00', '沈阳转运中心', '快件已到达 沈阳转运中心', 'in_transit'],
      ['2024-09-30T23:38:00+08:00', '西安转运中心', '快件已发往 沈阳转运中心', 'in_transit'],
      ['2024-09-30T23:36:00+08:00', '西安转运中心', '快件已到达 西安转运中心', 'in_transit'],
      ['2024-09-30T18:07:00+08:00', '西安长安常宁分部', '快件已发往 西安转运中心', 'in_transit'],
      ['2024-09-30T18:07:00+08:00', '西安长安常宁分部', '西安长安常宁分部 已揽收', 'accepted'],
      ['2024-09-30T16:16:00+08:00', undefined, `中通转单号：${zto('locker')}`, 'in_transit'],
      ['2024-09-27T10:12:00+08:00', undefined, '货物交送海关，清关中', 'customs'],
      ['2024-09-26T18:25:00+08:00', undefined, '抵达中国处理中心', 'in_transit'],
      ['2024-09-24T01:28:00-07:00', undefined, '航班已配载，飞往中国途中', 'in_transit'],
      ['2024-09-23T17:52:00-07:00', undefined, '货物到达温哥华机场，准备发往中国，计划24小时内起飞', 'in_transit'],
    ]);
    expect(events.map((event) => [event.time_zone, event.time_zone_basis]).slice(-5)).toEqual([
      ['Asia/Shanghai', 'destination'], ['Asia/Shanghai', 'destination'], ['Asia/Shanghai', 'place'],
      ['America/Vancouver', 'carrier'], ['America/Vancouver', 'place'],
    ]);
    expect(events.slice(0, 10).every((event) => event.time_zone === 'Asia/Shanghai' && event.time_zone_basis === 'place')).toBe(true);
    expect(events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
  });

  it('reads a parcel delivered by hand without the courier, the signatory or the phones', () => {
    const result = parseEsoway(raw('delivered'), DELIVERED, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: '您的快件已送达',
      last_update: '2026-03-27T11:11:00+08:00', weight_kg: 0.5, delivery_carrier: 'zto', delivery_tracking_number: zto('delivered') });
    const events = result.events!;
    expect(events).toHaveLength(14);
    expect(events.slice(0, 2)).toEqual([
      { time: '2026-03-27T11:11:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'place', local_time: '2026-03-27T11:11',
        location: '深圳园山', description: '您的快件已送达', stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-03-27T07:15:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'place', local_time: '2026-03-27T07:15',
        location: '深圳园山', description: '深圳园山 快递员正在为您派件', stage: 'out_for_delivery', stage_source: 'carrier_map' },
    ]);
    expect(events.find((event) => event.local_time === '2026-03-25T16:06' && event.stage === 'accepted'))
      .toMatchObject({ location: '西安曲江二部', description: '快件已揽收' });
    // Pacific daylight time had started.
    expect(events.slice(-2).map((event) => event.time)).toEqual(['2026-03-17T01:30:00-07:00', '2026-03-16T18:01:00-07:00']);
    expect(JSON.stringify(result)).not.toMatch(PERSONAL);
  });

  it('reads ZTO\'s sentences without the people, phones, pickup spot or courtesy, and its city in brackets as the place', () => {
    expect(esowayRow('【西安市】 西安长安常宁分部（029-12345678）某某（13800000000） 已揽收', '西安长安常宁分部'))
      .toEqual({ description: '西安长安常宁分部 已揽收', location: '西安市' });
    expect(esowayRow('73532000000000', '中通转单号')).toEqual({ description: '中通转单号：73532000000000' });
    expect(esowayRow('抵达中国处理中心', '')).toEqual({ description: '抵达中国处理中心' });
    expect(esowayPlace('丰巢的某小区南门外丰巢柜1号柜')).toBe('');
    expect(esowayPlace('中通转单号')).toBe('');
    expect(esowayPlace('沈阳长白二部')).toBe('沈阳长白二部');
  });

  it('dates a row on Vancouver\'s or China\'s clock by what it says, and leaves one that says neither on its wall clock', () => {
    expect(esowayZone('', '货物到达温哥华机场，准备发往中国')).toEqual({ zone: 'America/Vancouver', basis: 'place' });
    expect(esowayZone('', '航班已配载，飞往中国途中')).toEqual({ zone: 'America/Vancouver', basis: 'carrier' });
    expect(esowayZone('Burnaby', '已收货')).toEqual({ zone: 'America/Vancouver', basis: 'place' });
    expect(esowayZone('', '抵达中国处理中心')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(esowayZone('', '货物交送海关，清关中')).toEqual({ zone: 'Asia/Shanghai', basis: 'destination' });
    expect(esowayZone('中通转单号', '73532000000000')).toEqual({ zone: 'Asia/Shanghai', basis: 'destination' });
    expect(esowayZone('西安转运中心', '【西安市】 快件已到达 西安转运中心')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(esowayZone('', '已收货')).toBeNull();
    const undated = parseEsoway(changed('<INFO>航班已配载，飞往中国途中', '<INFO>已收货'), LOCKER, READ_AT).events!
      .find((event) => event.description === '已收货');
    expect(undated).toEqual({ local_time: '2024-09-24T01:28', description: '已收货' });
  });

  it('names ZTO only for one waybill row with a ZTO number that REFER_NBR does not contradict', () => {
    const waybill = zto('locker');
    const row = (description: string) => ({ local_time: '2024-09-30T16:16', description });
    expect(esowayOnward(waybill, [row(`中通转单号：${waybill}`)], LOCKER)).toEqual({ delivery_carrier: 'zto', delivery_tracking_number: waybill });
    expect(esowayOnward('', [row(`中通转单号：${waybill}`)], LOCKER)).toEqual({ delivery_carrier: 'zto', delivery_tracking_number: waybill });
    expect(esowayOnward(waybill, [], LOCKER)).toEqual({});
    expect(esowayOnward('73599658260435', [row(`中通转单号：${waybill}`)], LOCKER)).toEqual({});
    expect(esowayOnward('', [row(`中通转单号：${waybill}`), row('中通转单号：73599658260435')], LOCKER)).toEqual({});
    expect(esowayOnward('', [row('中通转单号：SF1234567890123')], LOCKER)).toEqual({});
    expect(parseEsoway(changed(/<PLACE>中通转单号<\/PLACE><INFO>\d+/, '<PLACE>中通转单号</PLACE><INFO>12345678'), LOCKER, READ_AT))
      .not.toHaveProperty('delivery_carrier');
  });

  it('reads the record\'s delivered state, and leaves out a row dated after the lookup', () => {
    const withoutDelivery = changed(/<DATETIME>2024-10-04 11:51<\/DATETIME>.*\r?\n/, '');
    expect(parseEsoway(withoutDelivery, LOCKER, READ_AT)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_status_text: '快件已在 丰巢暂放，请及时取件' });
    expect(parseEsoway(withoutDelivery.replace('<STATE>3', '<STATE>1'), LOCKER, READ_AT))
      .toMatchObject({ current_stage: 'ready_for_pickup' });
    expect(parseEsoway(raw('locker'), LOCKER, Date.parse('2024-10-02T16:00:00+08:00')).last_update_local).toBe('2024-10-02T15:03');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseEsoway(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseEsoway(raw('locker'), DELIVERED, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEsoway(changed(/^100/, '-1'), LOCKER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEsoway(changed('<DATETIME>2024-09-26 ', '<DATETIME>2024-09-31 '), LOCKER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseEsoway(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), LOCKER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new EsowayTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(LOCKER, { budgetMs: 5000 });
    await expect(new EsowayTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('locker'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.esoway.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeEsowayNumber(` ${LOCKER} `)).toBe(LOCKER);
    expect(normalizeEsowayNumber('dd-2025 1202')).toBe('DD20251202');
    for (const number of ['ES12345', 'ABCDEFGHIJ', '1'.repeat(31), 'ES2002/471990CA', '']) {
      expect(() => normalizeEsowayNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new EsowayTracker({ fetcher }).fetch('ES12345')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new EsowayTracker({ fetcher }).fetch(LOCKER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'esoway', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps ESOWAY\'s and ZTO\'s sentences, whatever branch or centre they name', () => {
    expect(esowayStage('快件已发往 广州转运中心')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(esowayStage('广州天河 的业务员正在为您派件')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(esowayStage('快件已在 菜鸟驿站暂放，请及时取件')).toEqual({ stage: 'ready_for_pickup', source: 'carrier_map' });
    expect(esowayStage('货物交送海关，清关中')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(statusMap.stage(null, '中通转单号：73532000000000')).toBe('in_transit');
    expect(statusMap.stage(null, '快件到达')).toBeUndefined();
    expect(statusMap.stage('1', '您的快递已签收')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});

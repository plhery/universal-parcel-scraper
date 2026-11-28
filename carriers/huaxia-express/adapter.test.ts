import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HUAXIA_API, HUAXIA_SITE, HuaxiaTracker, huaxiaLookupUrl } from './adapter.js';
import { huaxiaRow, huaxiaZone, normalizeHuaxiaNumber, parseHuaxia } from './parser.js';
import { huaxiaStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'HE1000999990';
const SF = 'SF3192819028046';
// After the sample's newest row.
const READ_AT = Date.parse('2026-11-26T12:00:00Z');
const raw = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('Huaxia Express tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 2).toLowerCase()} ${NUMBER.slice(2, 7)}-${NUMBER.slice(7)}`;
    const result = await new HuaxiaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(huaxiaLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(HUAXIA_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: HUAXIA_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'huaxia-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, each row dated on the clock of the network that wrote it', () => {
    const result = parseHuaxia(raw('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已派送成功', last_update: '2025-07-24T15:21:00+08:00', last_update_local: '2025-07-24T15:21',
      expected_delivery: null, destination_country: 'CN', weight_kg: 1, delivery_carrier: 'sf-express', delivery_tracking_number: SF });
    const events = result.events!;
    expect(events).toHaveLength(25);
    const instants = events.map((event) => Date.parse(event.time!));
    expect(instants).toEqual([...instants].sort((left, right) => right - left));
    expect(events[0]).toEqual({ time: '2025-07-24T15:21:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'place',
      local_time: '2025-07-24T15:21', location: '武汉市', description: '您的快件已派送成功', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[1]).toMatchObject({ location: '武汉市', description: '快件交给，正在派送途中', stage: 'out_for_delivery' });
    // The station's address is cut, its bracket closed.
    expect(events[3]).toMatchObject({ description: '快件到达 【武汉东西湖永旺营业店】', stage: 'in_transit' });
    expect(events.find((event) => event.location === '沈阳市/铁岭市/抚顺市')).toMatchObject({ time: '2025-07-23T05:12:00+08:00' });
    // The delay notice keeps no stage.
    expect(events.find((event) => event.description?.includes('交通管制'))).not.toHaveProperty('stage');
    expect(events.find((event) => event.description?.startsWith('到达口岸清关中')))
      .toMatchObject({ time: '2025-07-21T17:11:00+08:00', time_zone_basis: 'place', stage: 'customs' });
    // The Canadian side writes Vancouver's clock: the flight leaves before it lands, a day ahead on China's clock.
    expect(events.slice(-4).map((event) => [event.time, event.time_zone, event.time_zone_basis, event.location, event.stage])).toEqual([
      ['2025-07-18T00:46:00-07:00', 'America/Vancouver', 'carrier', undefined, 'in_transit'],
      ['2025-07-17T12:28:00-07:00', 'America/Vancouver', 'place', undefined, 'in_transit'],
      ['2025-07-17T10:33:00-07:00', 'America/Vancouver', 'place', 'Richmond', 'in_transit'],
      ['2025-07-15T15:39:00-07:00', 'America/Vancouver', 'place', 'Richmond', 'accepted']]);
    // The courier's name and phone, where the parcel was left and the notes after them stay out.
    expect(JSON.stringify(result)).not.toMatch(/张三|13800000000|家门口|电话|地址|如有疑问|如有任何/);
  });

  it('drops the courier\'s name and phone, a signatory and the notes after them, and keeps Huaxia\'s own rows', () => {
    expect(huaxiaRow('快件交给【张三，联系电话：13800000000】，正在派送途中（如有任何问题可先联系我）'))
      .toEqual({ description: '快件交给，正在派送途中' });
    expect(huaxiaRow('您的快件已派送成功（家门口），如有疑问请电联快递员【张三，电话：13800000000】。感谢您'))
      .toEqual({ description: '您的快件已派送成功' });
    expect(huaxiaRow('快件到达 【某营业店，地址：某区某路1号】')).toEqual({ description: '快件到达 【某营业店】' });
    expect(huaxiaRow('已出库，送至温哥华机场，等待航班起飞 【YVR】')).toEqual({ description: '已出库，送至温哥华机场，等待航班起飞 【YVR】' });
  });

  it('dates a row on the clock its place, or the leg it names, is on', () => {
    expect(huaxiaZone('Richmond', '已出库【国际快件调度中心】')).toEqual({ zone: 'America/Vancouver', basis: 'place' });
    expect(huaxiaZone('哈尔滨市', '快件到达 【哈尔滨龙运转运中心】')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(huaxiaZone('', '航班起飞，温哥华 - 中国 【国际运输途中】')).toEqual({ zone: 'America/Vancouver', basis: 'carrier' });
    expect(huaxiaZone('', '到达口岸清关中，请耐心等待 【中国海关】')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(huaxiaZone('', '包裹已揽收【Canada】')).toEqual({ zone: 'America/Vancouver', basis: 'place' });
    expect(huaxiaZone('', '运输中')).toBeNull();
    expect(huaxiaZone('Toronto', '运输中')).toBeNull();
  });

  it('names SF Express only for SF\'s interface and a number SF\'s rules claim whole', () => {
    for (const [from, to] of [['<TRANSKIND>丰桥接口', '<TRANSKIND>其他'], [`<TRANS_NBR>${SF}`, '<TRANS_NBR>3192819028046'],
      [`<TRANS_NBR>${SF}`, '<TRANS_NBR>']]) {
      const result = parseHuaxia(changed(from!, to!).replace(`<REFER_NBR>${SF}`, '<REFER_NBR>'), NUMBER, READ_AT);
      expect(result, to).not.toHaveProperty('delivery_carrier');
      expect(result, to).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads the record\'s delivered state, and leaves out a row dated after the lookup', () => {
    const withoutDelivery = changed(/<DATETIME>2025-07-24 15:21<\/DATETIME>.*\r?\n/, '');
    expect(parseHuaxia(withoutDelivery, NUMBER, READ_AT)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      current_stage_source: 'carrier_map', last_status_text: '快件交给，正在派送途中' });
    expect(parseHuaxia(withoutDelivery.replace('<STATE>3', '<STATE>1'), NUMBER, READ_AT))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(parseHuaxia(raw('delivered'), NUMBER, Date.parse('2025-07-24T15:00:00+08:00')).last_update_local).toBe('2025-07-24T14:17');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHuaxia(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHuaxia(raw('delivered'), 'HE1000147482', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHuaxia(changed(/^100/, '-1'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHuaxia(changed('<DATETIME>2025-07-22 16:12<', '<DATETIME>2025-07-32 16:12<'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHuaxia(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new HuaxiaTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(raw('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.huaxiaglobal.ca/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeHuaxiaNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['HE', 'HE100014748', 'HE10001474811', 'VE1000147481', 'HE10001474/1', '']) {
      expect(() => normalizeHuaxiaNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HuaxiaTracker({ fetcher }).fetch('HE')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new HuaxiaTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'huaxia-express', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the rows by their sentence, whatever place the brackets name', () => {
    expect(huaxiaStage('快件在【上海转运中心】完成分拣，准备发往 【南京转运中心】')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(huaxiaStage('包裹已揽收，正在安排出库，快递高峰期如有延误请谅解【Canada】')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(huaxiaStage('我们正在为您的快件分配最合适的快递员，请您稍等')).toBeNull();
    expect(statusMap.stage(null, '快件到达 【武汉东西湖转运中心】')).toBe('in_transit');
    expect(statusMap.stage(null, '快件到达')).toBeUndefined();
    expect(statusMap.stage('1', '快件到达 【武汉东西湖转运中心】')).toBeUndefined();
    expect(statusMap.gaps).toHaveLength(2);
  });
});

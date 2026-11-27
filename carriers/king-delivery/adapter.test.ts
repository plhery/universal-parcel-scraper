import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, KING_DELIVERY_API, KING_DELIVERY_SITE, KingDeliveryTracker, kingDeliveryLookupUrl } from './adapter.js';
import { kingDeliveryPlace, kingDeliveryRow, normalizeKingDeliveryNumber, parseKingDelivery } from './parser.js';
import { kingDeliveryStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'KDZGZ999999999';
// After the sample's newest row, on Beijing's clock.
const READ_AT = Date.parse('2026-11-26T12:00:00+08:00');
const raw = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('King Delivery tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 5).toLowerCase()} ${NUMBER.slice(5, 9)}-${NUMBER.slice(9)}`;
    const result = await new KingDeliveryTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(kingDeliveryLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(KING_DELIVERY_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: KING_DELIVERY_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'king-delivery', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, with wall clocks, its places and JD as the delivering carrier', () => {
    const result = parseKingDelivery(raw('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件已由门卫代收，感谢您使用快达物流，期待再次为您服务', last_update: null,
      last_update_local: '2023-01-09T15:46', expected_delivery: null, weight_kg: 9.6,
      delivery_carrier: 'jd-logistics', delivery_tracking_number: 'JDVA18410019873' });
    expect(result).not.toHaveProperty('destination_country');
    const events = result.events!;
    // The blank first row is skipped and the courier's two calls at one minute read as one.
    expect(events).toHaveLength(20);
    expect(events.every((event) => !event.time && event.local_time)).toBe(true);
    const clocks = events.map((event) => event.local_time as string);
    expect(clocks).toEqual([...clocks].sort().reverse());
    expect(events[0]).toEqual({ local_time: '2023-01-09T15:46', description: '您的快件已由门卫代收，感谢您使用快达物流，期待再次为您服务',
      stage: 'delivered', stage_source: 'carrier_map' });
    // A call to the recipient keeps no stage of its own; the call's result is left out.
    expect(events[1]).toEqual({ local_time: '2023-01-09T15:45', description: '快递员发起联系客户，呼叫方式：拨打电话' });
    expect(events[2]).toEqual({ local_time: '2023-01-09T14:47', description: '您的快件正在派送中，请您准备签收',
      stage: 'out_for_delivery', stage_source: 'carrier_map' });
    expect(events.find((event) => event.description === '您的快件已到达【北京通州分拣中心】'))
      .toMatchObject({ local_time: '2023-01-07T12:47', location: '北京通州分拣中心', stage: 'in_transit' });
    expect(events.slice(14, 17).map((event) => event.description))
      .toEqual(['您的快件已由【快达口岸分拣中心】揽收完成', '快达快递 已收取快件', '货物已交付快达物流']);
    expect(events.slice(14, 17).every((event) => event.stage === 'accepted')).toBe(true);
    // A put-off collection's PLACE is its reason, not a place.
    const putOff = events.filter((event) => event.description?.startsWith('您的快件因【理货未完成未准备好货物】操作再取'));
    expect(putOff.map((event) => [event.local_time, event.location, event.stage])).toEqual([
      ['2023-01-06T18:53', undefined, 'registered'], ['2023-01-06T14:58', undefined, 'registered']]);
    expect(events.at(-1)).toEqual({ local_time: '2023-01-06T09:20', description: '揽收任务已分配给快递员', stage: 'registered',
      stage_source: 'carrier_map' });
    // The courier's name and phone, the care notices, the signatory and the order reference stay out.
    expect(JSON.stringify(result)).not.toMatch(/某某|13800000000|疫苗|外呼结果|20221219628/);
  });

  it('keeps only the first sentence of a row, without a courier\'s name, phone or signatory', () => {
    expect(kingDeliveryRow('揽收任务已分配给快递员某某，联系电话13800000000。 为保证安全，快达快递每日对网点消毒！'))
      .toEqual({ description: '揽收任务已分配给快递员' });
    expect(kingDeliveryRow('您的快件正在派送中，请您准备签收（快递员：某某，联系电话：13800000000）。 祝您身体健康。'))
      .toEqual({ description: '您的快件正在派送中，请您准备签收' });
    expect(kingDeliveryRow('您的快件已由某某签收，感谢使用')).toEqual({ description: '您的快件已签收，感谢使用' });
    expect(kingDeliveryRow('您的快件已签收，签收人：某某')).toEqual({ description: '您的快件已签收' });
    expect(kingDeliveryRow('快递员正在派送，电话：010-12345678')).toEqual({ description: '快递员正在派送' });
    expect(kingDeliveryRow('快递员发起联系客户，呼叫方式：拨打电话。外呼结果：已接通，通话时长：9秒。'))
      .toEqual({ description: '快递员发起联系客户，呼叫方式：拨打电话' });
    expect(kingDeliveryRow('快达快递 已收取快件')).toEqual({ description: '快达快递 已收取快件' });
    expect(kingDeliveryPlace('温州分拣中心', '您的快件已到达【温州分拣中心】')).toBe('温州分拣中心');
    expect(kingDeliveryPlace('理货未完成', '您的快件因【理货未完成】操作再取')).toBe('');
  });

  it('names JD only for the JD service and a number JD\'s rules claim whole', () => {
    for (const [from, to] of [['<TRANSKIND>京东快递', '<TRANSKIND>顺丰速运'], ['<TRANS_NBR>JDVA18410019873', '<TRANS_NBR>18410019873'],
      ['<TRANS_NBR>JDVA18410019873', '<TRANS_NBR>'], ['<TRANS_NBR>JDVA18410019873', `<TRANS_NBR>${NUMBER}`]]) {
      const result = parseKingDelivery(changed(from!, to!), NUMBER, READ_AT);
      expect(result, to).not.toHaveProperty('delivery_carrier');
      expect(result, to).not.toHaveProperty('delivery_tracking_number');
    }
    expect(parseKingDelivery(changed('<TRANS_NBR>JDVA18410019873', '<TRANS_NBR>jdva 1841001 9873'), NUMBER, READ_AT))
      .toMatchObject({ delivery_carrier: 'jd-logistics', delivery_tracking_number: 'JDVA18410019873' });
  });

  it('reads the record\'s delivered state, and leaves out a row dated after the lookup', () => {
    const withoutDelivery = changed(/<DATETIME>2023-01-09 15:46<\/DATETIME>.*\r?\n/, '');
    expect(parseKingDelivery(withoutDelivery, NUMBER, READ_AT)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      current_stage_source: 'carrier_map', last_status_text: '快递员发起联系客户，呼叫方式：拨打电话' });
    // Without it, the call moves nothing and the round leads.
    expect(parseKingDelivery(withoutDelivery.replace('<STATE>3', '<STATE>1'), NUMBER, READ_AT))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery' });
    expect(parseKingDelivery(raw('delivered'), NUMBER, Date.parse('2023-01-09T15:00:00+08:00')).last_update_local).toBe('2023-01-09T14:47');
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseKingDelivery(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseKingDelivery(raw('delivered'), 'KDZGZ660002597', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKingDelivery(changed(/^100/, '-1'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKingDelivery(changed('<DATETIME>2023-01-07 12:09<', '<DATETIME>2023-01-32 12:09<'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // Only a wholly blank row is skipped: wording without a clock is a changed reply.
    expect(() => parseKingDelivery(changed('<DATETIME>2023-01-07 12:09<', '<DATETIME><'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKingDelivery(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n<DATETIME></DATETIME><PLACE></PLACE><INFO></INFO>\r\n</TRACK_DATA>'),
      NUMBER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new KingDeliveryTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(raw('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.kuaidaexp.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeKingDeliveryNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['KDZGZ', 'KDZGZABCDEFGHI', `KDZGZ${'1'.repeat(30)}`, 'KDZGZ6600/02596', '']) {
      expect(() => normalizeKingDeliveryNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new KingDeliveryTracker({ fetcher }).fetch('KDZGZ')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new KingDeliveryTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'king-delivery', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the rows by their sentence, whatever facility the brackets name', () => {
    expect(kingDeliveryStage('您的快件在【上海分拣中心】分拣完成')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(kingDeliveryStage('您的快件由【上海分拣中心】准备发往【南京分拣中心】')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(kingDeliveryStage('您的快件因【联系不上寄件人】操作再取，下次揽收时间2023-02-01 09:00-2023-02-01 10:00'))
      .toEqual({ stage: 'registered', source: 'carrier_map' });
    expect(kingDeliveryStage('快递员发起联系客户，呼叫方式：拨打电话')).toBeNull();
    expect(statusMap.stage(null, '您的快件已到达【温州分拣中心】')).toBe('in_transit');
    expect(statusMap.stage(null, '您的快件已到达')).toBeUndefined();
    expect(statusMap.stage('1', '您的快件已到达【温州分拣中心】')).toBeUndefined();
    expect(statusMap.gaps).toEqual([{ wording: '快递员发起联系客户，呼叫方式：拨打电话', note: expect.any(String) }]);
  });
});

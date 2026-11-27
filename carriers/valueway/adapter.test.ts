import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, VALUEWAY_API, VALUEWAY_SITE, ValuewayTracker, valuewayLookupUrl, valuewayPageUrl } from './adapter.js';
import { normalizeValuewayNumber, parseValueway, valuewayHandoff, valuewayRow, valuewayZone } from './parser.js';
import { statusMap, valuewayStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'VE900000000CA';
const SF = 'SF1671658002111';
// After the sample's newest row.
const READ_AT = Date.parse('2026-11-26T12:00:00Z');
const raw = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const pageBytes = () => readFileSync(new URL('./fixtures/page.html', import.meta.url));
const page = () => new TextDecoder('gb18030').decode(pageBytes());
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });
// The record for the EmsApiTrack request and the page for the EmmisTrack one.
const served = (pageReply: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async (url) => (
  new URL(String(url)).searchParams.get('MfcISAPICommand') === 'EmsApiTrack' ? response(raw('delivered')) : pageReply()));

describe('Valueway Express tracking lookup', () => {
  it('asks the tracking server for the record, then the page, through the supplied transport', async () => {
    const fetcher = served(() => response(pageBytes()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 2).toLowerCase()} ${NUMBER.slice(2, 7)}-${NUMBER.slice(7)}`;
    const result = await new ValuewayTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', delivery_carrier: 'sf-express', delivery_tracking_number: SF });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[recordUrl, recordInit], [pageUrl, pageInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(String(recordUrl)).toBe(valuewayLookupUrl(NUMBER));
    const asked = new URL(String(recordUrl));
    expect(`${asked.origin}${asked.pathname}`).toBe(VALUEWAY_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: NUMBER });
    expect(Object.fromEntries(new URL(String(pageUrl)).searchParams))
      .toEqual({ MfcISAPICommand: 'EmmisTrack', w: 'valueway', ntype: '1000', cmodel: 'new:tracking', cno: NUMBER });
    expect(String(pageUrl)).toBe(valuewayPageUrl(NUMBER));
    for (const init of [recordInit, pageInit]) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
        Referer: VALUEWAY_SITE, 'User-Agent': 'SyntheticHost/1.0',
      } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'valueway', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, each row dated on the clock of the network that wrote it', () => {
    const result = parseValueway(raw('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '您的快件代签收', last_update: '2023-02-22T14:50:00+08:00', last_update_local: '2023-02-22T14:50',
      expected_delivery: null, weight_kg: 1.426 });
    // The record's REFER_NBR is a note, and its destination a province.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('destination_country');
    const events = result.events!;
    expect(events).toHaveLength(24);
    const instants = events.map((event) => Date.parse(event.time!));
    expect(instants).toEqual([...instants].sort((left, right) => right - left));
    expect(events[0]).toEqual({ time: '2023-02-22T14:50:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'place',
      local_time: '2023-02-22T14:50', location: '衡水市', description: '您的快件代签收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[1]).toMatchObject({ location: '衡水市', description: '快件交给，正在派送途中', stage: 'out_for_delivery' });
    expect(events.find((event) => event.description === '顺丰速运 已收取快件'))
      .toMatchObject({ time: '2023-02-20T11:21:00+08:00', location: '长沙市', stage: 'in_transit' });
    expect(events.find((event) => event.description?.startsWith('清关中')))
      .toMatchObject({ time: '2023-02-14T14:36:00+08:00', time_zone_basis: 'place', location: '中国长沙', stage: 'customs' });
    // The flight notice keeps no stage; Valueway writes it on Toronto's clock.
    expect(events.find((event) => event.description?.startsWith('航班延误'))).toEqual({ time: '2023-02-06T10:33:00-05:00',
      time_zone: 'America/Toronto', time_zone_basis: 'carrier', local_time: '2023-02-06T10:33', description: '航班延误，转运时间延长。Expection delay for flight' });
    // The forwarding warehouse's departure, on China's clock, comes before the Toronto hub's.
    expect(events.slice(-3).map((event) => [event.time, event.time_zone, event.time_zone_basis, event.stage])).toEqual([
      ['2023-01-11T16:58:00-05:00', 'America/Toronto', 'place', 'in_transit'],
      ['2023-01-12T00:19:00+08:00', 'Asia/Shanghai', 'carrier', 'in_transit'],
      ['2022-12-30T14:26:00+08:00', 'Asia/Shanghai', 'carrier', 'accepted']]);
    // The signer note, the call notice and the piece count stay out.
    expect(JSON.stringify(result)).not.toMatch(/门卫|联系电话|安全呼叫|主单总件数|如有疑问|70KY/);
  });

  it('keeps a row dated after the lookup on its wall clock alone, and leaves out one dated after it on China\'s clock', () => {
    // An hour after the delivery: the delivery row is still a scan, read with its zone.
    expect(parseValueway(raw('delivered'), NUMBER, Date.parse('2023-02-22T15:50:00+08:00')).last_update).toBe('2023-02-22T14:50:00+08:00');
    // Before the Toronto hub's row on Toronto's clock, after it on China's: the row stays, without an instant.
    const result = parseValueway(raw('delivered'), NUMBER, Date.parse('2023-01-11T09:00:00Z'));
    expect(result.events!.map((event) => event.local_time)).toEqual(['2023-01-11T16:58', '2022-12-30T14:26']);
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result).toMatchObject({ last_update: null, last_update_local: '2023-01-11T16:58' });
  });

  it('drops the people a domestic courier\'s row names, their phones and the notes after them', () => {
    expect(valuewayRow('[长沙市]快件运输中')).toEqual({ description: '快件运输中', location: '长沙市' });
    expect(valuewayRow('【深圳市】快件交给某某，正在派送途中（联系电话：13800000000）')).toEqual({ description: '快件交给，正在派送途中', location: '深圳市' });
    expect(valuewayRow('[衡水市]快件交给某某，正在派送途中（联系电话：，顺丰已开启“安全呼叫”保护您的电话隐私,请放心接听！）（主单总件数：1件）'))
      .toEqual({ description: '快件交给，正在派送途中', location: '衡水市' });
    expect(valuewayRow('[衡水市]您的快件已由某某签收，如有疑问请电联快递员【某某，电话：13800000000】'))
      .toEqual({ description: '您的快件已签收', location: '衡水市' });
    expect(valuewayRow('[杭州市]【杭州转运中心】的派送员-某某（13800000000）正在派件')).toEqual({ description: '【杭州转运中心】的派送员正在派件', location: '杭州市' });
    expect(valuewayRow('[杭州市]快递员某某，联系电话13800000000，正在为您派件')).toEqual({ description: '快递员', location: '杭州市' });
    expect(valuewayRow('[杭州市]快件已暂存至某某小区驿站，请及时取件')).toEqual({ description: '快件已暂存', location: '杭州市' });
    expect(valuewayRow('[杭州市]快件派送中，电话0571-12345678')).toEqual({ description: '快件派送中', location: '杭州市' });
    // A bracketed point that is no city is not a place.
    expect(valuewayRow('[杭州西湖营业点]快件已发车')).toEqual({ description: '快件已发车' });
    // Valueway's own rows are kept as written.
    const own = '加拿大多伦多转运仓出库扫描,送往多伦多皮尔逊国际机场。Toronto Hub Depart Scan to Toronto Pearson Airport';
    expect(valuewayRow(own)).toEqual({ description: own });
  });

  it('picks each row\'s zone from its place, else from the network that wrote it', () => {
    expect(valuewayZone('多伦多', '')).toEqual({ zone: 'America/Toronto', basis: 'place' });
    expect(valuewayZone('温哥华', '')).toEqual({ zone: 'America/Vancouver', basis: 'place' });
    expect(valuewayZone('Calgary', '')).toEqual({ zone: 'America/Edmonton', basis: 'place' });
    expect(valuewayZone('Richmond,BC,Canada', '')).toEqual({ zone: 'America/Vancouver', basis: 'place' });
    expect(valuewayZone('中国长沙', '')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(valuewayZone('中国香港', '')).toEqual({ zone: 'Asia/Hong_Kong', basis: 'place' });
    expect(valuewayZone('', '[长沙市]快件运输中')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(valuewayZone('', '[香港]快件运输中')).toEqual({ zone: 'Asia/Hong_Kong', basis: 'place' });
    expect(valuewayZone('', '中转仓揽收成功，Hub Pickup Scan')).toEqual({ zone: 'Asia/Shanghai', basis: 'carrier' });
    expect(valuewayZone('', '航班延误，转运时间延长。Expection delay for flight')).toEqual({ zone: 'America/Toronto', basis: 'carrier' });
  });

  it('names SF Express from the page only for the waybill asked and a number SF Express\'s rules claim whole', () => {
    expect(valuewayHandoff(page(), NUMBER)).toEqual({ delivery_carrier: 'sf-express', delivery_tracking_number: SF });
    expect(valuewayHandoff(page(), NUMBER.toLowerCase())).toEqual({ delivery_carrier: 'sf-express', delivery_tracking_number: SF });
    for (const [from, to] of [[`var cNum='${NUMBER}'`, `var cNum='${UNKNOWN}'`], [`var cNum='${NUMBER}';`, ''],
      ["var cKey='KD100-shunfeng,'", "var cKey='KD100-yunda,'"], ["var cKey='KD100-shunfeng,'", "var cKey='KD100-shunfeng,KD100-yunda,'"],
      [`var cNo='${SF}'`, "var cNo='4312345678901'"], [`var cNo='${SF}'`, `var cNo='${SF},SF1671658002120'`], [`var cNo='${SF}'`, "var cNo=''"],
      [`var cNo='${SF}'`, `var cNo='${NUMBER}'`], [`var cNo='${SF}';`, `var cNo='${SF}';\r\nvar cNo='${SF}';`]]) {
      expect(valuewayHandoff(page().replace(from!, to!), NUMBER), to).toEqual({});
    }
  });

  it('keeps the record when the page fails, and stops on the caller\'s cancellation', async () => {
    for (const reply of [() => response('', { status: 500 }), () => response('', { status: 302, headers: { Location: VALUEWAY_SITE } }),
      () => response('<html><title>Just a moment...</title></html>'), () => response('', { status: 429, headers: { 'retry-after': '7' } }),
      () => Promise.reject(new TypeError('fetch failed'))]) {
      const result = await new ValuewayTracker({ fetcher: served(reply) }).fetch(NUMBER, { budgetMs: 5000 });
      expect(result).toMatchObject({ status: 'delivered', last_status_text: '您的快件代签收' });
      expect(result).not.toHaveProperty('delivery_carrier');
      expect(result).not.toHaveProperty('delivery_tracking_number');
    }
    const controller = new AbortController();
    const cancelled = served(() => {
      controller.abort(new Error('cancelled'));
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    await expect(new ValuewayTracker({ fetcher: cancelled }).fetch(NUMBER, { budgetMs: 5000, signal: controller.signal }))
      .rejects.toThrow('cancelled');
  });

  it('recognizes a waybill by the record alone', async () => {
    const fetcher = served(() => response(pageBytes()));
    const recognizer = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    await expect(recognizer.recognize!(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ known: true });
    expect(fetcher).toHaveBeenCalledOnce();
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null })
      .recognize!(UNKNOWN, { budgetMs: 5000 })).resolves.toEqual({ known: false });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseValueway(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseValueway(raw('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseValueway(changed(/^100/, '-1'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseValueway(changed('<DATETIME>2023-02-14 14:36<', '<DATETIME>2023-02-30 14:36<'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseValueway(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body, init));
      return new ValuewayTracker({ fetcher }).fetch(NUMBER, { budgetMs: 5000 }).finally(() => {
        // Only a found record leads to the page.
        expect(fetcher.mock.calls.every(([url]) => String(url) === valuewayLookupUrl(NUMBER))).toBe(true);
      });
    };
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(raw('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: VALUEWAY_SITE } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeValuewayNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['VE01', 'VEABCDEFGHICA', `VE${'1'.repeat(30)}CA`, 'VE0150/56238CA', '']) {
      expect(() => normalizeValuewayNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ValuewayTracker({ fetcher }).fetch('VE01')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new ValuewayTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'valueway', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the rows by their sentence, whatever place or facility they name', () => {
    expect(valuewayStage('发往中国广州转运中心。In transit to Guangzhou,China')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(valuewayStage('抵达中国广州转运中心，等待清关。Arrival Scan In Guangzhou,China and pending for Customs clearance'))
      .toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(valuewayStage('快件在【广州花都中转场】完成分拣，准备发往 【深圳中转场】')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(valuewayStage('航班延误，转运时间延长。Expection delay for flight')).toBeNull();
    expect(statusMap.stage(null, '快件到达 【深圳中转场】')).toBe('in_transit');
    expect(statusMap.stage('1', '快件到达 【深圳中转场】')).toBeUndefined();
    expect(statusMap.gaps).toEqual([{ wording: '航班延误，转运时间延长。expection delay for flight', note: expect.any(String) }]);
  });
});

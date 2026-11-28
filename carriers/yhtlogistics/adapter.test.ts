import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, YHT_API, YHT_SITE, YhtTracker, yhtLookupUrl } from './adapter.js';
import { normalizeYhtNumber, parseYht, yhtRow, yhtZone } from './parser.js';
import { statusMap, yhtStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
const UNKNOWN = '999999999990';
// After the sample's newest row, on Shanghai's clock.
const READ_AT = Date.parse('2026-11-28T12:00:00+08:00');
type Fixture = 'delivered' | 'not-found';
const bytes = (name: Fixture) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url));
// The server answers in GBK.
const raw = (name: Fixture) => new TextDecoder('gb18030').decode(bytes(name));
const changed = (from: string | RegExp, to: string) => raw('delivered').replace(from, to);
const response = (body: BodyInit, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html' }, ...init });
// The DHL waybill the record gives in TRANS_NBR.
const DHL = /<TRANS_NBR>(\d+)<\/TRANS_NBR>/.exec(raw('delivered'))![1]!;
const CN = 'EAST CHINA AREA - CHINA, PEOPLES REPUBLIC';
const AU = 'BRISBANE - AUSTRALIA';
const SG = 'SINGAPORE - SINGAPORE';

describe('Shanghai Aerospace Logistics tracking lookup', () => {
  it('asks the tracking server for the whole waybill through the supplied transport, and reads its GBK', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${SAMPLE.slice(0, 4)} ${SAMPLE.slice(4, 8)}-${SAMPLE.slice(8)}`;
    const result = await new YhtTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '已派送' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(yhtLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(YHT_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ MfcISAPICommand: 'EmsApiTrack', cno: SAMPLE });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: YHT_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'yhtlogistics', step: 'direct', outcome: 'ok' }));
  });

  it('dates China\'s and Singapore\'s rows on their clocks, keeps Australia\'s wall clocks, and names DHL Express', () => {
    const result = parseYht(raw('delivered'), SAMPLE, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已派送', last_update: null, last_update_local: '2018-11-14T11:33', expected_delivery: null,
      destination_country: 'AU', weight_kg: 40, delivery_carrier: 'dhl-express', delivery_tracking_number: DHL });
    expect(result.events!.map((event) => [event.time ?? null, event.time_zone_basis ?? null, event.local_time, event.location, event.description, event.stage])).toEqual([
      [null, null, '2018-11-14T11:33', 'BUNDALL', '已派送', 'delivered'],
      [null, null, '2018-11-14T08:47', AU, '快件正在派送中', 'out_for_delivery'],
      [null, null, '2018-11-14T08:23', AU, '已经到达营业地点，即将安排派送', 'in_transit'],
      [null, null, '2018-11-14T07:17', AU, '离开转运中心', 'in_transit'],
      [null, null, '2018-11-14T07:16', AU, '正在安排下一站转运', 'in_transit'],
      [null, null, '2018-11-13T15:24', AU, '海关已放行', 'in_transit'],
      [null, null, '2018-11-13T15:14', AU, '快件处于操作过程中', 'in_transit'],
      [null, null, '2018-11-13T14:58', AU, '海关状态更新', 'customs'],
      // The two forms of one clearance scan read once.
      [null, null, '2018-11-13T09:13', AU, '清关中', 'customs'],
      [null, null, '2018-11-13T09:06', AU, '到达转运中心', 'in_transit'],
      [null, null, '2018-11-13T03:18', AU, '海关状态更新', 'customs'],
      // The shipment's three pieces travel apart, so Singapore's rows and Brisbane's interleave.
      ['2018-11-12T18:20:00+08:00', 'place', '2018-11-12T18:20', SG, '离开转运中心', 'in_transit'],
      [null, null, '2018-11-12T12:14', AU, '清关中', 'customs'],
      [null, null, '2018-11-12T09:32', AU, '清关中', 'customs'],
      [null, null, '2018-11-12T09:27', AU, '到达转运中心', 'in_transit'],
      ['2018-11-12T06:33:00+08:00', 'place', '2018-11-12T06:33', SG, '正在安排下一站转运', 'in_transit'],
      [null, null, '2018-11-12T04:48', AU, '海关状态更新', 'customs'],
      ['2018-11-11T17:26:00+08:00', 'place', '2018-11-11T17:26', SG, '正在安排下一站转运', 'in_transit'],
      ['2018-11-11T16:41:00+08:00', 'place', '2018-11-11T16:41', SG, '离开转运中心', 'in_transit'],
      ['2018-11-11T15:44:00+08:00', 'place', '2018-11-11T15:44', SG, '到达转运中心', 'in_transit'],
      ['2018-11-10T22:02:00+08:00', 'place', '2018-11-10T22:02', CN, '离开转运中心', 'in_transit'],
      ['2018-11-10T22:01:00+08:00', 'place', '2018-11-10T22:01', CN, '正在安排下一站转运', 'in_transit'],
      ['2018-11-10T15:33:00+08:00', 'place', '2018-11-10T15:33', CN, '海关已放行', 'in_transit'],
      ['2018-11-10T04:31:00+08:00', 'place', '2018-11-10T04:31', CN, '清关中', 'customs'],
      ['2018-11-10T02:01:00+08:00', 'place', '2018-11-10T02:01', CN, '到达转运中心', 'in_transit'],
      ['2018-11-09T23:43:00+08:00', 'place', '2018-11-09T23:43', 'SHANGHAI - CHINA, PEOPLES REPUBLIC', '离开转运中心', 'in_transit'],
      ['2018-11-09T23:43:00+08:00', 'place', '2018-11-09T23:43', 'SHANGHAI - CHINA, PEOPLES REPUBLIC', '正在安排下一站转运', 'in_transit'],
      [null, null, '2018-11-09T22:48', AU, '海关状态更新', 'customs'],
      ['2018-11-09T22:19:00+08:00', 'place', '2018-11-09T22:19', '上海', '已取件', 'accepted'],
      ['2018-11-09T21:26:00+08:00', 'place', '2018-11-09T21:26', 'SHANGHAI - CHINA, PEOPLES REPUBLIC', 'DHL已取件', 'accepted'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/某某|签收人/u);
  });

  it('leaves out the place a row repeats and who signed', () => {
    expect(yhtRow(`离开转运中心 ${SG}`, SG)).toEqual({ description: '离开转运中心' });
    expect(yhtRow('离开转运中心', SG)).toEqual({ description: '离开转运中心' });
    expect(yhtRow(`离开转运中心 ${SG}`, AU)).toEqual({ description: `离开转运中心 ${SG}` });
    expect(yhtRow('已派送-签收人: 某某', 'BUNDALL')).toEqual({ description: '已派送' });
    expect(yhtRow('已派送 - 签收人：某某', 'BUNDALL')).toEqual({ description: '已派送' });
    expect(yhtRow('签收人: 某某', 'BUNDALL')).toEqual({ description: '已签收' });
  });

  it('takes a zone from the firm\'s office or a country with one clock, and none from a town alone or a country with several', () => {
    expect(yhtZone('上海')).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(yhtZone(CN)).toEqual({ zone: 'Asia/Shanghai', basis: 'place' });
    expect(yhtZone(SG)).toEqual({ zone: 'Asia/Singapore', basis: 'place' });
    expect(yhtZone('LEIPZIG - GERMANY')).toEqual({ zone: 'Europe/Berlin', basis: 'place' });
    expect(yhtZone(AU)).toBeNull();
    expect(yhtZone('CINCINNATI HUB, OH - USA')).toBeNull();
    expect(yhtZone('BUNDALL')).toBeNull();
    expect(yhtZone('')).toBeNull();
  });

  it('names DHL Express only for the DHL service and a waybill DHL Express\'s rules take', () => {
    for (const [from, to] of [['<TRANSKIND>DHL', '<TRANSKIND>UPS'], [`<TRANS_NBR>${DHL}`, '<TRANS_NBR>7594313916'],
      [`<TRANS_NBR>${DHL}`, '<TRANS_NBR>'], [`<TRANS_NBR>${DHL}`, `<TRANS_NBR>${SAMPLE}`], [`<TRANS_NBR>${DHL}`, '<TRANS_NBR>SF5157135484116']]) {
      const result = parseYht(changed(from!, to!), SAMPLE, READ_AT);
      expect(result, to).not.toHaveProperty('delivery_carrier');
      expect(result, to).not.toHaveProperty('delivery_tracking_number');
    }
    expect(parseYht(changed(`<TRANS_NBR>${DHL}`, `<TRANS_NBR>${DHL.slice(0, 2)} ${DHL.slice(2, 6)} ${DHL.slice(6)}`), SAMPLE, READ_AT))
      .toMatchObject({ delivery_carrier: 'dhl-express', delivery_tracking_number: DHL });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseYht(raw('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYht(raw('delivered'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYht(changed(/^100/, '-1'), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYht(changed(/<TRACK_DATA>[\s\S]*<\/TRACK_DATA>/, '<TRACK_DATA>\r\n</TRACK_DATA>'), SAMPLE, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: BodyInit, init?: ResponseInit) => new YhtTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(SAMPLE, { budgetMs: 5000 });
    await expect(new YhtTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(bytes('not-found'))) })
      .fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(bytes('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.yhtlogistics.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeYhtNumber(` ${SAMPLE} `)).toBe(SAMPLE);
    for (const number of ['8260931', 'ABCDEFGHIJ', '1'.repeat(31), `${SAMPLE}/1`, '']) {
      expect(() => normalizeYhtNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new YhtTracker({ fetcher }).fetch('8260931')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new YhtTracker({ fetcher }).fetch(SAMPLE, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'yhtlogistics', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps every wording in statuses.json', () => {
    for (const entry of statuses.entries) expect(yhtStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    expect(statusMap.stage('1', '已派送')).toBeUndefined();
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(statusMap.gaps).toEqual([]);
  });
});

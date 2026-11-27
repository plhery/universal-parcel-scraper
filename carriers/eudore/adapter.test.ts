import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, EUDORE } from './adapter.js';
import { eudoreStage, statusMap } from './status.js';
import { normalizeT6Number, parseT6, T6Tracker } from './t6.js';

const NUMBER = 'BS241202023FAI';
const WAYBILL = 'TS0004515CN';
const UNKNOWN = 'ZQ58301746XK';
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const list = () => JSON.parse(text('list.json'));
const html = () => text('item.html');
const listed = (change: (reply: ReturnType<typeof list>) => void) => { const reply = list(); change(reply); return reply; };
// The sample's timeline with its rows replaced by the ones given.
const timeline = (rows: readonly { date: string; location?: string; info: string }[]) => html()
  .replace(/<ul class="layui-timeline">[\s\S]*<\/ul>/, `<ul class="layui-timeline">${rows.map((row) => `<li class="layui-timeline-item trackitem"><p>
    <span class="trackdate">${row.date}</span>${row.location === undefined ? '' : `<span class="tracklocation">${row.location}</span>`}
    <span class="trackinfo">${row.info}</span></p></li>`).join('')}</ul>`);
const parse = (reply: unknown = list(), page = html(), number = NUMBER) => parseT6(reply, page, number, EUDORE, READ_AT);
const response = (body: string, init: ResponseInit = {}, type = 'application/json') => new Response(body,
  { status: 200, headers: { 'content-type': type }, ...init });

describe('Eudore on the T6 platform', () => {
  it('searches the number, then asks for the timeline of the waybill found, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(text('list.json')))
      .mockResolvedValueOnce(response(html(), {}, 'text/html;charset=utf-8'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new T6Tracker(EUDORE, { fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' bs2412-0202-3fai ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[listUrl, listInit], [itemUrl, itemInit]] = fetcher.mock.calls as [[URL, RequestInit], [URL, RequestInit]];
    expect(String(listUrl)).toBe('https://tbwl.t6soft.com/trackList');
    expect(Object.fromEntries(listInit.body as URLSearchParams)).toEqual({ 'searchList.waybillnumber': NUMBER,
      'searchListField.waybillnumber': 'border.systemnumber,border.customernumber1,border.waybillnumber,border.tracknumber,border.newtracknumber,border.fbanumber',
      searchLang: 'zh' });
    expect(String(itemUrl)).toBe('https://tbwl.t6soft.com/trackItem');
    expect(Object.fromEntries(itemInit.body as URLSearchParams)).toEqual({ orderpkid: '42144', waybillnumber: WAYBILL, searchLang: 'zh' });
    for (const init of [listInit, itemInit]) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    }
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'eudore', step: 'direct', outcome: 'ok' }));
  });

  it("reads the sample's timeline on its places' clocks, without the milestone strip, postcode or FBA shipment", () => {
    const result = parse();
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '签收单（POD）已回传', last_update: '2025-02-13T10:07:05-05:00', expected_delivery: null, destination_country: 'US' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events).toHaveLength(16);
    expect(result.events![0]).toEqual({ local_time: '2025-02-13T10:07:05', time: '2025-02-13T10:07:05-05:00', time_zone: 'America/New_York',
      time_zone_basis: 'place', location: 'NEW YORK, NY, US', description: '签收单（POD）已回传', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.find((event) => event.description === '已离港')).toMatchObject({ local_time: '2024-12-22T18:00:11',
      time: '2024-12-22T18:00:11+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'place', location: 'CHINA', stage: 'in_transit' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2024-12-14T15:02:36+08:00', location: 'SHENZHEN, CHINA',
      description: '运件抵达我司操作中心', stage: 'accepted' });
    expect(result.events!.find((event) => event.description === '航程延误，ETA延迟至27.JAN')).toMatchObject({ stage: 'in_transit' });
    expect(result.events!.find((event) => event.description!.startsWith('卡车派送已出仓'))).toMatchObject({ stage: 'out_for_delivery',
      time: '2025-02-11T09:35:35-05:00' });
    expect(result.events!.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    // The strip's own times, such as the arrival entered on 5 February, are not rows.
    expect(result.events!.some((event) => event.local_time === '2025-02-05T11:27:58')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/08873|FBA18MN1SKV5|TB241214000593/);
  });

  it('dates a row without a place on the platform clock, and keeps a wall clock no zone settles', () => {
    const page = timeline([
      { date: '2026-11-27 21:30:00', location: '【LOS ANGELES,CA,US】', info: '已拆柜' },
      { date: '2026-11-20 08:00', location: '【】', info: '运件抵达我司操作中心' },
      { date: '2026-11-19 10:00:00', location: '【QXZWV YARD】', info: '已离港' },
      { date: '2026-11-18 10:00:00', location: '【US】', info: '已抵港' },
      { date: '2026-11-17 10:00:00', info: '新的轨迹' },
    ]);
    const events = parse(list(), page).events!;
    // On Los Angeles's clock the first row would come after the read: its wall clock stays alone.
    expect(events[0]).toEqual({ local_time: '2026-11-27T21:30:00', location: 'LOS ANGELES, CA, US', description: '已拆柜',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events[1]).toEqual({ local_time: '2026-11-20T08:00:00', time: '2026-11-20T08:00:00+08:00', time_zone: 'Asia/Shanghai',
      time_zone_basis: 'carrier', description: '运件抵达我司操作中心', stage: 'accepted', stage_source: 'carrier_map' });
    expect(events[2]).toEqual({ local_time: '2026-11-19T10:00:00', location: 'QXZWV YARD', description: '已离港', stage: 'in_transit',
      stage_source: 'carrier_map' });
    expect(events[3]).not.toHaveProperty('time');
    expect(events[4]).toMatchObject({ time: '2026-11-17T10:00:00+08:00', time_zone_basis: 'carrier', description: '新的轨迹' });
    expect(events[4]).not.toHaveProperty('stage');
    expect(parse(list(), page)).toMatchObject({ last_update: null, last_update_local: '2026-11-27T21:30:00' });
  });

  it('keeps the postcode, FBA shipment and signatory out of the rows', () => {
    const page = timeline([
      { date: '2025-02-13 10:07:05', location: '【SOMERSET,NJ,08873,US】', info: '已送达FBA仓（FBA18MN1SKV5），签收人：J. SAMPLE' },
      { date: '2025-02-12 10:07:05', location: '【NEW YORK,NY,US】', info: '派送至 08873 的卡车已出仓 FBA19ZZZZZZZ' },
    ]);
    const events = parse(list(), page).events!;
    expect(events[0]).toMatchObject({ location: 'SOMERSET, NJ, US', description: '已送达FBA仓', time_zone: 'America/New_York' });
    expect(events[1]).toMatchObject({ description: '派送至 的卡车已出仓' });
    expect(JSON.stringify(events)).not.toMatch(/08873|FBA1|SAMPLE/);
  });

  it('reads the search for an unknown number as not found, and nothing else', async () => {
    expect(() => parse(JSON.parse(text('not-found.json')), html(), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parse({ code: 0, data: [] }, html())).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse({ code: 1, msg: '系统繁忙', data: [], count: 0 }, html())).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ code: 1, msg: '系统繁忙' }, html())).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ msg: 'ok', data: [] }, html())).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(list(), html(), 'BS241202024FAI')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(listed((r) => { r.data[0].pkid = '42144'; }), html())).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(listed((r) => { r.data[0].customernumber1 = { value: NUMBER }; }), html())).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(list(), html().replace(`track-item-data-${WAYBILL}`, 'track-item-data-TS0004516CN')))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(list(), '<html><body>系统错误</body></html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(list(), '<html><title>Just a moment...</title></html>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parse(list(), timeline([]))).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parse(list(), timeline([{ date: '2025-02-13 24:00:00', info: '已拆柜' }]))).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new T6Tracker(EUDORE, { fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup('', { status: 302, headers: { Location: '/logon' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(text('list.json'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 429, headers: { 'Retry-After': '30' } })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup('<html><script>var arg1="acw_sc__v2"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>维护中</html>')).rejects.toMatchObject({ kind: 'schema' });
  });

  it('takes the waybill the number is its own reference or waybill of, when several carry it', () => {
    const other = { ...list().data[0], pkid: 42145, customernumber1: 'BS241202024FAI', waybillnumber: 'TS0004516CN', systemnumber: 'TB241214000594' };
    expect(parse(listed((r) => { r.data.push(other); r.count = 2; })).events).toHaveLength(16);
    // Two waybills of one FBA shipment: the number names neither alone.
    expect(() => parse(listed((r) => { r.data.push(other); r.count = 2; }), html(), 'FBA18MN1SKV5'))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parse(listed((r) => { r.data.push({ ...r.data[0], pkid: 42145 }); r.count = 2; }), html()))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parse(list(), html(), 'TB241214000593').events).toHaveLength(16);
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeT6Number('bs 2412-0202-3fai', 'Eudore')).toBe(NUMBER);
    for (const number of ['BS24', 'BS241202023FAI/1', 'X'.repeat(41)]) {
      expect(() => normalizeT6Number(number, 'Eudore')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new T6Tracker(EUDORE, { fetcher }).fetch('BS/24')).rejects.toMatchObject({ kind: 'invalid_input' });
    const instance = adapter({ fetcher, recorder: NOOP_RECORDER } as never);
    expect(instance).toMatchObject({ id: 'eudore', steps: ['direct', 'retry'], recordsSteps: true });
    await expect(instance.recognize!('BS/24', {})).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps the line's wordings, with a delay's new arrival date", () => {
    expect(eudoreStage('运件抵达我司操作中心')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(eudoreStage('航程延误，ETA延迟至3.MAR')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage(null, '卡车派件已送达，POD签收单待回传')).toBe('delivered');
    expect(statusMap.stage(null, '新的轨迹')).toBeUndefined();
  });
});

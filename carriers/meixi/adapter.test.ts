import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, FlowLinkTracker, MEIXI, meixiPlace, normalizeFlowLinkNumber, parseFlowLink } from './adapter.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
const UNKNOWN = '99999999990';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Row = { time: string; context: string; CNCode: string };
type Waybill = { CNum: string; OtherName: string; OtherNum: string; list: Row[]; ErrorCode: string; ErrorMsg: string };
type Reply = { data: Waybill[]; code: number; msg: string };
const text = () => readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8');
const json = () => JSON.parse(text()) as Reply;
const waybill = (change: Partial<Waybill> & Record<string, unknown>) => JSON.stringify({ ...json(), data: [{ ...json().data[0]!, ...change }] });
const rows = (...added: Row[]) => [...json().data[0]!.list, ...added];
// The system's answer for a number it does not know, as it gave it for an invented number.
const notFound = (number: string) => JSON.stringify({ data: [{ CNum: number, OtherName: '', OtherNum: '', kouan: '', phone4: '', list: [],
  ErrorCode: 'NotExistsCNum', ErrorMsg: '[运单号/转运单号]不存在!', ExpressCompanyApiErrorMsg: '', OrderRecipientName: '',
  OrderRecipientAddress: '' }], code: 0, msg: '获取成功' });
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

describe('Meixi Express tracking lookup', () => {
  it('posts the whole number with an empty body to the j5ex FlowLink host through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new FlowLinkTracker(MEIXI, { fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${SAMPLE.slice(0, 5)}-${SAMPLE.slice(5)} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(9);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`http://flowlinkj5ex.changyunda.cn/APIAdmin/Account/TrackingSelectDomain?CNum=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'POST', body: '', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Origin: 'https://www.j5ex.com', Referer: 'https://www.j5ex.com/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'meixi', step: 'direct', outcome: 'ok' }));
  });

  it('reads the US side\'s rows on Los Angeles\' clock and China\'s on China\'s, with SF Express after clearance', () => {
    const result = parseFlowLink(MEIXI, text(), SAMPLE, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '【中国】包裹清关完成，进入国内物流环节。请耐心等待派送', last_update: '2026-07-28T16:41:23+08:00',
      last_update_local: '2026-07-28T16:41:23', expected_delivery: null, destination_country: 'CN',
      delivery_carrier: 'sf-express', delivery_tracking_number: json().data[0]!.OtherNum });
    expect(result.events!.map((event) => [event.time, event.time_zone_basis, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-07-28T16:41:23+08:00', 'place', '中国', '【中国】包裹清关完成，进入国内物流环节。请耐心等待派送', 'GIN_SUCCESS', 'in_transit'],
      ['2026-07-22T15:03:00+08:00', 'place', '中国', '【中国】包裹转至清关口岸，开始清关', 'GIN_PROCESSING', 'customs'],
      ['2026-07-20T12:16:00+08:00', 'place', '中国', '【中国】包裹到达中国，等待转运至清关口岸', 'GIN_START', 'in_transit'],
      ['2026-07-19T07:00:00-07:00', 'carrier', undefined, '【美国-中国】包裹美国运往中国途中', 'GM_DEPARTURE', 'in_transit'],
      ['2026-07-17T15:43:50-07:00', 'place', '美国洛杉矶', '【美国洛杉矶】包裹送往LAX国际机场', 'GEX_START', 'in_transit'],
      ['2026-07-14T15:02:29-07:00', 'place', '美国洛杉矶', '【美国洛杉矶】包裹美国仓分拣中', 'GFT_DEPARTURE', 'in_transit'],
      ['2026-07-14T14:52:20-07:00', 'place', '美国洛杉矶', '【美国洛杉矶】包裹已扣款，核验身份证信息运往分拣仓库', 'GFT_ARRIVAL', 'in_transit'],
      ['2026-07-14T13:16:58-07:00', 'carrier', undefined, '【美西速运】包裹已称重揽收', 'G_GOT', 'accepted'],
      ['2026-07-09T02:32:35-07:00', 'carrier', undefined, '包裹已制单，暂未揽收', undefined, 'registered'],
    ]);
    expect(result.events!.at(-1)).toEqual({ time: '2026-07-09T02:32:35-07:00', time_zone: 'America/Los_Angeles', time_zone_basis: 'carrier',
      local_time: '2026-07-09T02:32:35', description: '包裹已制单，暂未揽收', stage: 'registered', stage_source: 'carrier_map' });
  });

  it('never reads the recipient\'s name, address or phone digits beside the rows', () => {
    const result = parseFlowLink(MEIXI, waybill({ phone4: '0000', OrderRecipientName: '某**', OrderRecipientAddress: '某省某市*****',
      kouan: 'none', ExpressCompanyApiErrorMsg: '[某顺丰Api查询失败/无轨迹]' }), SAMPLE, READ_AT);
    expect(JSON.stringify(result)).not.toMatch(/0000|某|\*\*|Api/u);
  });

  it('dates a row by its brackets, and one without by its code', () => {
    expect(meixiPlace('美西速运', 'G_GOT')).toEqual({ location: '', zone: null });
    expect(meixiPlace('美国-中国', 'GM_DEPARTURE')).toEqual({ location: '', zone: null });
    expect(meixiPlace('美国洛杉矶', 'GFT_ARRIVAL')).toEqual({ location: '美国洛杉矶', zone: { zone: 'America/Los_Angeles', basis: 'place' } });
    expect(meixiPlace('美国', 'GFT_ARRIVAL')).toEqual({ location: '美国', zone: null });
    expect(meixiPlace('中国', 'GIN_START')).toEqual({ location: '中国', zone: { zone: 'Asia/Shanghai', basis: 'place' } });
    expect(meixiPlace('西安市', 'GLT_DEPARTURE')).toEqual({ location: '西安市', zone: { zone: 'Asia/Shanghai', basis: 'place' } });
    expect(meixiPlace('', '')).toEqual({ location: '', zone: null });
    expect(meixiPlace('', 'G_SIGN')).toEqual({ location: '', zone: { zone: 'Asia/Shanghai', basis: 'destination' } });
    const relayed = parseFlowLink(MEIXI, waybill({ list: rows({ time: '2026-07-30 09:10:00', context: '已签收，签收人凭取货码签收', CNCode: 'G_SIGN' }) }), SAMPLE, READ_AT);
    expect(relayed).toMatchObject({ current_stage: 'delivered', delivered_at: '2026-07-30T09:10:00+08:00' });
    expect(relayed.events![0]).toMatchObject({ time: '2026-07-30T09:10:00+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'destination' });
  });

  it('hands off only to SF Express when the reply names it and its rules offer the number', () => {
    const handed = (change: Partial<Waybill>) => parseFlowLink(MEIXI, waybill(change), SAMPLE, READ_AT);
    expect(handed({ OtherName: '' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherNum: '' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherName: '某快递' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherNum: SAMPLE })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherName: '' })).not.toHaveProperty('destination_country');
  });

  it('reads NotExistsCNum for the number asked as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseFlowLink(MEIXI, notFound(UNKNOWN), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFlowLink(MEIXI, notFound('99999999991'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlowLink(MEIXI, waybill({ ErrorCode: 'Other' }), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlowLink(MEIXI, waybill({ list: [] }), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new FlowLinkTracker(MEIXI, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) }).fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(notFound(UNKNOWN))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(notFound(UNKNOWN), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeFlowLinkNumber(MEIXI, SAMPLE)).toBe(SAMPLE);
    const fetcher = vi.fn<typeof fetch>();
    await expect(new FlowLinkTracker(MEIXI, { fetcher }).fetch('8001&CNum=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'meixi', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps each code and text in statuses.json, and a code of one stage without its text', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code || null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage('GIN_PROCESSING', normalizeStatusWording('【中国】包裹清关中'))).toBe('customs');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
  });
});

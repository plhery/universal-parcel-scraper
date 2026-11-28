import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, JDX_EXPRESS } from './adapter.js';
import { flowlinkLookupUrl, flowlinkStage, flowlinkText, FlowLinkTracker, normalizeFlowLinkNumber, parseFlowLink, type FlowLinkSite } from './flowlink.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SAMPLE = numbers.records[0]!.number;
const UNKNOWN = 'ZQX5073198QQ';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Row = { time: string; context: string; CNCode: string };
type Waybill = { CNum: string; OtherName: string; OtherNum: string; list: Row[]; ErrorCode: string; ErrorMsg: string };
type Reply = { data: Waybill[]; code: number; msg: string };
const text = () => readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const json = () => JSON.parse(text()) as Reply;
const waybill = (change: Partial<Waybill>) => JSON.stringify({ ...json(), data: [{ ...json().data[0]!, ...change }] });
// The system's answer for a number it does not know, as it gave it for an invented number.
const notFound = (number: string) => JSON.stringify({ data: [{ CNum: number, OtherName: '', OtherNum: '', kouan: '', phone4: '', list: [],
  ErrorCode: 'NotExistsCNum', ErrorMsg: '[运单号/转运单号]不存在!', ExpressCompanyApiErrorMsg: '', OrderRecipientName: '',
  OrderRecipientAddress: '' }], code: 0, msg: '获取成功' });
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

describe('JDX Express tracking lookup', () => {
  it('posts the whole number with an empty body to the tenant\'s FlowLink host through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new FlowLinkTracker(JDX_EXPRESS, { fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${SAMPLE.toLowerCase()} `, { budgetMs: 5000 });
    expect(result.events).toHaveLength(19);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`http://flowlinkjdxexpress.changyunda.cn/APIAdmin/Account/TrackingSelectDomain?CNum=${SAMPLE}`);
    expect(init).toMatchObject({ method: 'POST', body: '', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Origin: 'http://www.jdxexpress.com', Referer: 'http://www.jdxexpress.com/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jdxexpress', step: 'direct', outcome: 'ok' }));
  });

  it('reads the rows on Hong Kong\'s clock, newest first, with STO as the courier in China', () => {
    const result = parseFlowLink(JDX_EXPRESS, text(), SAMPLE, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '已签收，签收人凭取货码签收', last_update: '2026-06-02T19:42:55+08:00', last_update_local: '2026-06-02T19:42:55',
      delivered_at: '2026-06-02T19:42:55+08:00', expected_delivery: null, destination_country: 'CN',
      delivery_carrier: 'sto', delivery_tracking_number: json().data[0]!.OtherNum });
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-06-02T19:42:55', undefined, '已签收，签收人凭取货码签收', 'G_SIGN', 'delivered'],
      ['2026-06-02T16:37:43', undefined, '快件已暂存至深圳西乡永丰八区24号店菜鸟驿站', 'GLT_DEPARTURE', 'ready_for_pickup'],
      ['2026-06-02T13:41:20', '深圳市', '【深圳市】快件已到达 广东深圳宝安区坪洲公司', 'GLT_DEPARTURE', 'in_transit'],
      ['2026-06-02T13:41:20', '深圳市', '【深圳市】广东深圳宝安区坪洲公司 的快递员正在为您派送', 'GLT_DEPARTURE', 'out_for_delivery'],
      ['2026-06-02T07:19:45', '深圳市', '【深圳市】快件已发往 广东深圳宝安区坪洲公司', 'GLT_DEPARTURE', 'in_transit'],
      ['2026-06-02T06:45:57', '深圳市', '【深圳市】快件已到达 广东深圳转运中心', 'GLT_DEPARTURE', 'in_transit'],
      ['2026-06-02T03:15:49', '中山市', '【中山市】预计06月02日到达【深圳市】', 'GLT_DEPARTURE', 'in_transit'],
      ['2026-06-02T03:12:05', '中山市', '【中山市】快件已发往 广东深圳转运中心', 'GLT_DEPARTURE', 'in_transit'],
      ['2026-06-02T03:09:37', '中山市', '【中山市】快件已到达 广东中山转运中心', 'GLT_DEPARTURE', 'in_transit'],
      ['2026-06-02T01:35:37', '佛山市', '【佛山市】快件已发往 广东中山转运中心', 'GLT_DEPARTURE', 'in_transit'],
      ['2026-06-01T20:41:58', '佛山市', '【佛山市】广东佛山禅城区南庄北公司 已揽收', 'GLT_DEPARTURE', 'in_transit'],
      ['2026-05-30T12:50:53', '深圳市', `[深圳市]已转单，转单号：${json().data[0]!.OtherNum}`, undefined, 'in_transit'],
      ['2026-05-30T07:50:06', '深圳市', '[深圳市][深圳口岸]清關中', 'GIN_PROCESSING', 'customs'],
      ['2026-05-30T07:49:52', '深圳市', '[深圳市][深圳國際港口]已提貨', 'GIN_START', 'in_transit'],
      ['2026-05-30T06:49:35', '深圳市', '[深圳市]幹線汽運已抵達', undefined, 'in_transit'],
      ['2026-05-30T05:49:10', '新界', '[新界]幹線汽運已從[香港國際倉]發出', undefined, 'in_transit'],
      ['2026-05-30T04:48:50', '新界', '[新界]包裹已離開[香港國際倉]，下一站[深 圳]', 'GFT_DEPARTURE', 'in_transit'],
      ['2026-05-30T03:47:21', '新界', '[新界]包裹已從[香港國際倉]出庫，等待幹線 運輸', 'GFT_ARRIVAL', 'in_transit'],
      ['2026-05-30T01:46:17', '新界', '[新界][香港九龍倉]已攬件', 'G_GOT', 'accepted'],
    ]);
    expect(result.events!.at(-1)).toEqual({ time: '2026-05-30T01:46:17+08:00', time_zone: 'Asia/Hong_Kong', time_zone_basis: 'carrier',
      local_time: '2026-05-30T01:46:17', location: '新界', description: '[新界][香港九龍倉]已攬件', provider_code: 'G_GOT',
      stage: 'accepted', stage_source: 'carrier_map' });
    // The relayed rows' couriers and phones are gone, whatever the fixture put in their place.
    expect(JSON.stringify(result)).not.toMatch(/某某|1380000000|0757000|0755000|95543/u);
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseFlowLink(JDX_EXPRESS, text(), SAMPLE, Date.parse('2026-06-02T10:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2026-06-02T16:37:43+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-06-02T19:42:55' });
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('hands off only to a courier the reply names whose rules offer the number', () => {
    const handed = (change: Partial<Waybill>) => parseFlowLink(JDX_EXPRESS, waybill(change), SAMPLE, READ_AT);
    expect(handed({ OtherName: '' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherNum: '' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherName: '某快递' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherNum: '1234' })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherNum: SAMPLE })).not.toHaveProperty('delivery_carrier');
    expect(handed({ OtherName: '' })).not.toHaveProperty('destination_country');
  });

  it('takes couriers, signers, phones and hotlines out of a text and keeps waybills', () => {
    expect(flowlinkText('【佛山市】某公司(075700000000)的张三(13800000000) 已揽收，若出现揽收后物流长时间未更新，请及时联系我们（【075700000000】或官方客服95543）核实'))
      .toBe('【佛山市】某公司 已揽收');
    expect(flowlinkText('【深圳市】某公司 的快递员(张三/13800000000)正在为您派送，【物流问题无需找商家或平台，请致电（075500000000）或专属渠道95543更快解决】，可关注“申通快递”官方微信公众号获取实时物流信息'))
      .toBe('【深圳市】某公司 的快递员正在为您派送');
    expect(flowlinkText('快件已暂存至某驿站，如有疑问请联系13800000000，投诉电话【075500000000】')).toBe('快件已暂存至某驿站');
    expect(flowlinkText('【某站】派件中,派送人：张三,电话:13800000000')).toBe('【某站】派件中');
    expect(flowlinkText('【某站】的派件员【张三】正在为您派件')).toBe('【某站】的派件员正在为您派件');
    expect(flowlinkText('已签收，签收人：张三。')).toBe('已签收');
    expect(flowlinkText('【某站】的 张三（138****0000） 正在第1次派件')).toBe('【某站】 正在第1次派件');
    expect(flowlinkText('[深圳市]已转单，转单号：773424442583645')).toBe('[深圳市]已转单，转单号：773424442583645');
    expect(flowlinkText('厦门分拣中心已收箱，箱号BC1002261007241483523429')).toBe('厦门分拣中心已收箱，箱号BC1002261007241483523429');
    expect(flowlinkText('请拨打13800000000')).toBe('');
  });

  it('reads NotExistsCNum for the number asked as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseFlowLink(JDX_EXPRESS, notFound(UNKNOWN), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseFlowLink(JDX_EXPRESS, notFound('ZQX5073199QQ'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlowLink(JDX_EXPRESS, waybill({ ErrorCode: 'NotExistsCNum' }), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlowLink(JDX_EXPRESS, waybill({ ErrorCode: 'Other' }), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlowLink(JDX_EXPRESS, waybill({ list: [] }), SAMPLE, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseFlowLink(JDX_EXPRESS, '{"code":500,"msg":"系统异常：Object reference not set to an instance of an object.","data":{}}', UNKNOWN, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseFlowLink(JDX_EXPRESS, text(), 'YCJ0000001HK', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlowLink(JDX_EXPRESS, JSON.stringify({ ...json(), data: [json().data[0], json().data[0]] }), SAMPLE, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const clock = waybill({ list: [{ ...json().data[0]!.list[0]!, time: '2026-02-30 10:00:00' }] });
    expect(() => parseFlowLink(JDX_EXPRESS, clock, SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlowLink(JDX_EXPRESS, '[]', SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlowLink(JDX_EXPRESS, '<html>Runtime Error</html>', SAMPLE, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new FlowLinkTracker(JDX_EXPRESS, {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) }).fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(notFound(UNKNOWN))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(notFound(UNKNOWN), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 411 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.changyunda.cn/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeFlowLinkNumber(JDX_EXPRESS, SAMPLE.toLowerCase())).toBe(SAMPLE);
    for (const number of ['YCJ10', 'JDXEXPRESS', `Y${'1'.repeat(30)}`, `${SAMPLE},${UNKNOWN}`, '']) {
      expect(() => normalizeFlowLinkNumber(JDX_EXPRESS, number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new FlowLinkTracker(JDX_EXPRESS, { fetcher }).fetch('YCJ104&CNum=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new FlowLinkTracker(JDX_EXPRESS, { fetcher }).fetch(SAMPLE, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'jdxexpress', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('asks another tenant\'s host for a site that brings its own, and refuses a tenant that is no subdomain', async () => {
    const other: FlowLinkSite = { ...JDX_EXPRESS, carrier: 'other', provider: 'Other', tenant: 'other', page: undefined };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(notFound(UNKNOWN)));
    await expect(new FlowLinkTracker(other, { fetcher }).fetch(UNKNOWN, { budgetMs: 5000 })).rejects.toMatchObject({ kind: 'not_found' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(`http://flowlinkother.changyunda.cn/APIAdmin/Account/TrackingSelectDomain?CNum=${UNKNOWN}`);
    expect(fetcher.mock.calls[0]![1]!.headers).not.toHaveProperty('Referer');
    expect(() => flowlinkLookupUrl({ ...other, tenant: 'evil.example.com/' }, UNKNOWN)).toThrow(TypeError);
  });

  it('offers JDX Express for its YCJ…HK waybills only', () => {
    expect(detectCarrierMatch(SAMPLE).candidates).toContain('jdxexpress');
    for (const number of ['MG9980105192', 'YCJ10402000HK', 'YCJ1040200CN']) expect(detectCarrierMatch(number).candidates).not.toContain('jdxexpress');
  });

  it('maps each code and text in statuses.json, a code of one stage without its text, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code || null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('[九龍][香港九龍倉]已攬件'))).toBeUndefined();
    expect(statusMap.stage('G_GOT', normalizeStatusWording('[九龍][香港九龍倉]已攬件'))).toBe('accepted');
    expect(statusMap.stage('GLT_DEPARTURE', normalizeStatusWording('【北京市】快件已到达 北京转运中心'))).toBe('in_transit');
    expect(statusMap.stage('GLT_DEPARTURE', normalizeStatusWording('【北京市】北京某公司 的快递员正在为您派送'))).toBe('out_for_delivery');
    expect(statusMap.stage('GLT_DEPARTURE', '新的状态')).toBeUndefined();
    expect(statusMap.stage('G_SIGN', '新的状态')).toBe('delivered');
    expect(flowlinkStage(JDX_EXPRESS, '新的状态', '')).toBeNull();
  });
});

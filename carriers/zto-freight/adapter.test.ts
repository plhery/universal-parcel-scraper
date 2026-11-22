import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { createTracker } from '../../facade/index.js';
import { ZtoFreightTracker } from './adapter.js';
import { normalizeZtoFreightNumber, parseZtoFreight, ZTO_FREIGHT_ENDPOINT, ZTO_FREIGHT_PAGE, ztoFreightJson } from './parser.js';
import { statusMap } from './status.js';

const DELIVERED = '320104477919';
const PROBLEM = 'ZY202472654496';
const raw = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(raw(name)) as { meta: unknown; data: string[] };
/** The fixture with its one waybill edited. */
type Row = Record<string, unknown> & { traces: Record<string, unknown>[] };
const edited = (name: string, edit: (row: Row) => void) => {
  const reply = fixture(name), row = JSON.parse(reply.data[0]!) as Row;
  edit(row); reply.data[0] = JSON.stringify(row); return reply;
};
const response = (body: string, status = 200) => new Response(body, { status });

describe('ZTO Freight guest adapter', () => {
  it('reads one whole waybill with the page headers and no ticket, cookie or account', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const result = await new ZtoFreightTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch(` ${DELIVERED} `, { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${ZTO_FREIGHT_ENDPOINT}?billCodes=${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Origin: 'https://www.zto56.com', Referer: ZTO_FREIGHT_PAGE, 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-11-21T15:10:41', last_status_text: '六安 已签收', expected_delivery: null });
  });

  it('keeps local clocks, scan types and branches without couriers, phones or remarks', () => {
    const result = parseZtoFreight(fixture('delivered.json'), DELIVERED);
    expect(result.events).toHaveLength(17);
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-11-19T16:58:55', provider_code: '揽收',
      description: '禹州宏科 已揽收', location: '许昌市', stage: 'accepted', stage_source: 'carrier_map' });
    expect(result.events!.find(event => event.provider_code === '发件')).toMatchObject({ description: '合肥分拨中心 发往 六安高新区' });
    expect(result.events!.find(event => event.provider_code === '派件')).toMatchObject({ description: '六安 正在派件', stage: 'out_for_delivery' });
    expect(result.events!.every(event => event.local_time && !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/\d{11}|咨询电话|本人|水槽|【/);
  });

  it('reads a problem scan reason and keeps the signature current over a later hub scan', () => {
    const result = parseZtoFreight(fixture('problem-scan.json'), PROBLEM);
    expect(result).toMatchObject({ status: 'delivered', last_update_local: '2026-10-16T07:03:13' });
    expect(result.events![0]).toMatchObject({ local_time: '2026-10-16T09:13:57', provider_code: '发车' });
    expect(result.events!.find(event => event.provider_code === '问题件')).toMatchObject({
      description: '问题件 · 客户要求自提', stage: 'exception' });
  });

  it('gives the estimate until the freight is signed for', () => {
    const result = parseZtoFreight(edited('delivered.json', row => { row.traces = row.traces.slice(0, -2); }), DELIVERED);
    expect(result).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2026-11-22' });
  });

  it('puts ZY in front of a 2024 waybill as the page does', async () => {
    expect(normalizeZtoFreightNumber('2024 7265 4496')).toBe(PROBLEM);
    expect(normalizeZtoFreightNumber('zy202472654496')).toBe(PROBLEM);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('problem-scan.json')));
    await new ZtoFreightTracker({ fetcher }).fetch('202472654496');
    expect(fetcher.mock.calls[0]![0]).toBe(`${ZTO_FREIGHT_ENDPOINT}?billCodes=${PROBLEM}`);
    for (const number of ['20247265449', '702364189245', 'ZY20247265449', '30236418924', 'ZTO302364189245']) {
      expect(() => normalizeZtoFreightNumber(number)).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('reports unknown and refused waybills as not found', () => {
    expect(() => parseZtoFreight(JSON.parse(raw('not-found.json')), '899999999990')).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const success = { success: true, code: 0, message: 'success' };
    expect(() => parseZtoFreight({ meta: success, data: '单号不符合规则,请输入正确的单号' }, 'ZY209999999993'))
      .toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const empty = JSON.stringify({ sendCity: '', predictTime: '', traces: '', orderStatus: '', billCode: '899999999990', receiptCity: '' });
    expect(() => parseZtoFreight({ meta: success, data: [empty] }, '899999999990')).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    const held = JSON.stringify({ sendCity: '许昌市', predictTime: '', traces: '', orderStatus: '', billCode: '899999999990', receiptCity: '' });
    expect(() => parseZtoFreight({ meta: success, data: [held] }, '899999999990')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires the whole waybill and a valid history', () => {
    for (const reply of [edited('delivered.json', row => { row.billCode = '320104477918'; }),
      edited('delivered.json', row => { row.traces[0]!.scanDate = '2026-02-30 10:00:00'; }),
      edited('delivered.json', row => { row.traces[0]!.scanType = 7; }),
      edited('delivered.json', row => { (row as Record<string, unknown>).traces = {}; }), { data: [] }]) {
      expect(() => parseZtoFreight(reply, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps failures, checks and malformed replies distinct', async () => {
    expect(() => parseZtoFreight({ meta: {} }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseZtoFreight({ meta: { success: false, message: '服务异常' } }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseZtoFreight({ meta: { success: false, message: '请求过于频繁' } }, DELIVERED)).toThrowError(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => ztoFreightJson('<html><title>滑动验证</title></html>')).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => ztoFreightJson('<html>maintenance</html>')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => ztoFreightJson('not JSON')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    for (const [status, kind] of [[403, 'challenge'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('{}', status));
      await expect(new ZtoFreightTracker({ fetcher }).fetch(DELIVERED)).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('maps the scan types and leaves others without a stage', () => {
    expect(statusMap.stage('签收', '')).toBe('delivered');
    expect(statusMap.stage('派件', '')).toBe('out_for_delivery');
    expect(statusMap.stage('退回', '')).toBeUndefined();
    const result = parseZtoFreight(edited('delivered.json', row => { row.traces.push({ ...row.traces.at(-1), scanType: '退回', scanDate: '2026-11-22 09:00:00' }); }), DELIVERED);
    expect(result.events![0]).toMatchObject({ provider_code: '退回', description: '退回 · 六安' });
    expect(result.events![0]!.stage).toBeUndefined();
  });

  it('detects ZY waybills and leaves the shared numeric ones to selection', async () => {
    expect(detectCarrierMatch(PROBLEM).candidates ?? [detectCarrierMatch(PROBLEM).carrier]).toContain('zto-freight');
    expect(detectCarrierMatch(DELIVERED).candidates ?? []).not.toContain('zto-freight');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered.json')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'zto-freight', number: DELIVERED });
    expect(tracked.source).toBe('zto-freight');
    expect(tracked.result.status).toBe('delivered');
  });
});

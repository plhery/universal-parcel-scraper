import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CHINASTAR_API, ChinastarTracker, chinastarLookupUrl } from './adapter.js';
import { chinastarStatusText, normalizeChinastarNumber, parseChinastar } from './parser.js';
import { chinastarStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const ORDER = numbers.records[1]!.number;
const WAYBILL = numbers.records[2]!.number;
const UNKNOWN = 'YGZS1999010199999';
// After both samples' newest nodes.
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Name = 'delivered' | 'by-order' | 'not-found';
const text = (name: Name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Name) => JSON.parse(text(name)) as { status: string; message: string; data: Record<string, unknown>[] | null };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, ...init });

describe('Huaxin Supply Chain tracking lookup', () => {
  it('posts the whole number to the service through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 4).toLowerCase()} ${NUMBER.slice(4, 12)}-${NUMBER.slice(12)}`;
    const result = await new ChinastarTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.events).toHaveLength(8);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(chinastarLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(CHINASTAR_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ danhao: NUMBER });
    expect(JSON.parse(String(init!.body))).toEqual({ cecNo: NUMBER });
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'chinastarlogistics', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first on China\'s clock, with the status each node\'s text gives and no operator or signer', () => {
    const result = parseChinastar(json('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '签收', last_update: '2023-04-17T18:31:31+08:00', last_update_local: '2023-04-17T18:31:31', expected_delivery: null });
    expect(result).not.toHaveProperty('canonical_tracking_number');
    const events = result.events!;
    expect(events.map((event) => [event.provider_code, event.description, event.stage])).toEqual([
      ['110', '签收', 'delivered'], ['100', '已运抵收货单位待签收', 'out_for_delivery'], ['50', '已发运', 'in_transit'],
      ['30', '已入库', 'in_transit'], ['25', '已从提货仓库离场', 'in_transit'], ['20', '已提货', 'accepted'],
      ['10', '已派车', 'registered'], ['09', '已受理', 'registered'],
    ]);
    expect(events[0]).toEqual({ time: '2023-04-17T18:31:31+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2023-04-17T18:31:31', location: '包头市', description: '签收', provider_code: '110', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events[7]).not.toHaveProperty('location');
    expect(JSON.stringify(result)).not.toMatch(/\*|操作人|调度员|signMan|operationMan/);
  });

  it('finds a waybill by the shipper\'s order and names the waybill as the canonical number', () => {
    const result = parseChinastar(json('by-order'), ORDER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', canonical_tracking_number: WAYBILL, last_update: '2024-10-11T16:56:00+08:00' });
    expect(result.events!.map((event) => event.description)).toEqual(['签收', '已运抵收货单位待签收', '派送中', '已到达：华欣北分仓库中转点',
      '从：华欣石家庄仓库中转发往华欣北分仓库', '已入库', '已从提货仓库离场', '已提货', '已派车', '已受理']);
    expect(result.events![2]).toMatchObject({ provider_code: '70', stage: 'out_for_delivery', location: '大兴区' });
    // Asked by the waybill, the same reply names no other number.
    expect(parseChinastar(json('by-order'), WAYBILL, READ_AT)).not.toHaveProperty('canonical_tracking_number');
  });

  it('refuses a reply with another number\'s node, and names no parcel for an order of several waybills', () => {
    const payload = json('delivered');
    const stray = { ...payload, data: [...payload.data!, { ...payload.data![0]!, logisticsOrderNo: 'YGZS2023041000461', customerOrderNumber: '1' }] };
    expect(() => parseChinastar(stray, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const order = json('by-order');
    const several = { ...order, data: [...order.data!, { ...order.data![0]!, logisticsOrderNo: 'YBJS2024100900629' }] };
    expect(() => parseChinastar(several, ORDER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    // Asked by one of those waybills, the other's nodes are another number's.
    expect(() => parseChinastar(several, WAYBILL, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const nameless = { ...payload, data: payload.data!.map((row) => ({ ...row, logisticsOrderNo: null })) };
    expect(() => parseChinastar(nameless, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('shows the node\'s name when its text gives no status or names a person', () => {
    expect(chinastarStatusText('操作人： [ *** ] 于时间： [ 2023-04-14 20:10:01 ] 状态： [ 已发运 ] ')).toBe('已发运');
    expect(chinastarStatusText('状态： 状态： [已入库 ')).toBe('已入库');
    expect(chinastarStatusText('调度员： [***] 于时间： [2023-04-11 01:48:46] 已派车')).toBe('');
    expect(chinastarStatusText('状态：[ 已签收，签收人：*** ]')).toBe('');
    expect(chinastarStatusText('状态：[ 派送中，电话 13800000000 ]')).toBe('');
  });

  it('leaves a node the zone would date after the lookup its wall clock alone', () => {
    const result = parseChinastar(json('delivered'), NUMBER, Date.parse('2023-04-17T10:00:00Z'));
    expect(result.events![0]).toEqual({ local_time: '2023-04-17T18:31:31', location: '包头市', description: '签收', provider_code: '110',
      stage: 'delivered', stage_source: 'carrier_map' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2023-04-17T18:31:31' });
  });

  it('reads the no-data answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseChinastar(json('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseChinastar({ ...json('not-found'), message: '系统繁忙' }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChinastar({ ...json('not-found'), status: '1' }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChinastar({ ...json('not-found'), data: [] }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseChinastar({ status: 0, data: null }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const payload = json('delivered');
    const clock = { ...payload, data: payload.data!.map((row) => ({ ...row, operationTime: '2023-04-31 18:31:31' })) };
    expect(() => parseChinastar(clock, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const blank = { ...payload, data: payload.data!.map((row) => ({ ...row, linkNodeName: '', contentDescription: '' })) };
    expect(() => parseChinastar(blank, NUMBER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new ChinastarTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.chinastarlogistics.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, and leaves the old system\'s numbers alone, without a request', async () => {
    expect(normalizeChinastarNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    expect(normalizeChinastarNumber(ORDER)).toBe(ORDER);
    for (const number of ['12345', 'YGZSABCDEFGHIJ', `Y${'1'.repeat(40)}`, 'YGZS2023/041000460', '', '0012345678']) {
      expect(() => normalizeChinastarNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new ChinastarTracker({ fetcher }).fetch('0012345678')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new ChinastarTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'chinastarlogistics', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('detects the Beijing and Guangzhou waybill shape only', () => {
    for (const number of [NUMBER, WAYBILL]) expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chinastarlogistics', confidence: 'high' });
    for (const number of ['YGZS202304100046', 'YGZS20230410004600', 'YGZS2023131000460', 'YSHS2023041000460', ORDER]) {
      expect(detectCarrierMatch(number).carrier, number).not.toBe('chinastarlogistics');
    }
  });

  it('maps each node by its code, as statuses.json records, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(entry.code, entry.wording), entry.code).toBe(entry.stage);
    expect(statusMap.stage(null, '签收')).toBeUndefined();
    expect(chinastarStage('999', '签收')).toMatchObject({ stage: 'delivered' });
    expect(chinastarStage('999', '新节点')).toBeNull();
  });
});

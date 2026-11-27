import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, WLKGO_API, WlkgoTracker, wlkgoLookupUrl } from './adapter.js';
import { normalizeWlkgoNumber, parseWlkgo, wlkgoAction } from './parser.js';
import { statusMap, wlkgoStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'SO199901019999';
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
type Name = 'delivered' | 'not-found';
type Package = { deliveryNO: string; tracks: Record<string, unknown>[] } & Record<string, unknown>;
type Reply = { result: boolean; keywords: string; packages?: Package[]; msg?: string };
const text = (name: Name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Name) => JSON.parse(text(name)) as Reply;
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

describe('WLKGO tracking lookup', () => {
  it('asks the service for the whole number, without a callback, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const typed = `${NUMBER.slice(0, 6).toLowerCase()} ${NUMBER.slice(6)}`;
    const result = await new WlkgoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(typed, { budgetMs: 5000 });
    expect(result.events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(wlkgoLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(WLKGO_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ Act: 'getOrderTrackInfo', orderNO: NUMBER });
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'wlkgo', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first on China\'s clock, with the bracketed place and no courier or phone', () => {
    const result = parseWlkgo(json('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '配送完毕,客户已签收', last_update: '2024-03-13T12:33:01+08:00', last_update_local: '2024-03-13T12:33:01',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.description, event.location ?? null, event.stage])).toEqual([
      ['配送完毕,客户已签收', null, 'delivered'], ['【古荡站】已出库,配送中', '古荡站', 'out_for_delivery'],
      ['【古荡站】已入库，待配送', '古荡站', 'in_transit'], ['正发往【古荡站】', '古荡站', 'in_transit'], ['【杭州仓】已装车,待出库', '杭州仓', 'accepted'],
    ]);
    expect(result.events![0]).toEqual({ time: '2024-03-13T12:33:01+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'carrier',
      local_time: '2024-03-13T12:33:01', description: '配送完毕,客户已签收', stage: 'delivered', stage_source: 'carrier_map' });
    expect(JSON.stringify(result)).not.toMatch(/\*|13800000000|配送员|电话|operater|tel/);
  });

  it('takes the courier, the signer, phones and the picture link out of a row\'s text', () => {
    expect(wlkgoAction('【古荡站】已出库,配送中,配送员为：***, 联系电话： 13800000000')).toBe('【古荡站】已出库,配送中');
    expect(wlkgoAction('配送完毕,客户已签收,签收人：***')).toBe('配送完毕,客户已签收');
    expect(wlkgoAction('配送完毕,客户已签收 <a class="signPhoto" href="https://img.example/sign.jpg">签收照片</a>')).toBe('配送完毕,客户已签收');
    expect(wlkgoAction('派送异常，请致电 0571-88888888')).toBe('派送异常，请致电');
    expect(wlkgoAction('电话：13800000000')).toBe('');
  });

  it('picks the package the number names, an order\'s only one, and no parcel for an order of several', () => {
    const payload = json('delivered');
    const first = payload.packages![0]!;
    const other = { ...first, deliveryNO: 'SO202403121567', tracks: [{ ...first.tracks[0], action: '正发往【某站】' }] };
    expect(parseWlkgo({ ...payload, packages: [other, first] }, NUMBER, READ_AT).events).toHaveLength(5);
    const order = { ...payload, packages: [{ ...first, deliveryNO: 'P0000001' }] };
    expect(parseWlkgo(order, NUMBER, READ_AT).events).toHaveLength(5);
    expect(() => parseWlkgo({ ...payload, packages: [{ ...first, deliveryNO: 'P0000001' }, { ...other, deliveryNO: 'P0000002' }] }, NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'several_parcels' }));
    expect(() => parseWlkgo({ ...payload, keywords: 'SO202403121567' }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWlkgo({ ...payload, packages: [{ ...first, deliveryNO: null }] }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseWlkgo(json('delivered'), NUMBER, Date.parse('2024-03-13T04:00:00Z'));
    expect(result.events![0]).not.toHaveProperty('time');
    expect(result.events![1]).toMatchObject({ time: '2024-03-13T07:40:38+08:00' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2024-03-13T12:33:01' });
  });

  it('reads the no-package answer for the number as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseWlkgo(json('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseWlkgo(json('not-found'), NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWlkgo({ ...json('not-found'), msg: '查询过于频繁' }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWlkgo({ result: true, keywords: NUMBER, packages: [] }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const payload = json('delivered');
    expect(() => parseWlkgo({ ...payload, packages: [{ ...payload.packages![0]!, tracks: [] }] }, NUMBER, READ_AT))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const clock = { ...payload, packages: [{ ...payload.packages![0]!, tracks: [{ date: '2024-02-30 10:00:00', action: '正发往【古荡站】' }] }] };
    expect(() => parseWlkgo(clock, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWlkgo({ result: 'true', keywords: NUMBER }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new WlkgoTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.wlkgo.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('jsonp({"result":false})', { headers: { 'content-type': 'text/javascript' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, without a request', async () => {
    expect(normalizeWlkgoNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['12345', 'SOABCDEFGH', `S${'1'.repeat(40)}`, 'SO2024/03121566', '']) {
      expect(() => normalizeWlkgoNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new WlkgoTracker({ fetcher }).fetch('SO&Act=x')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new WlkgoTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'wlkgo', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers WLKGO for no number shape', () => {
    expect(detectCarrierMatch(NUMBER).carrier).not.toBe('wlkgo');
  });

  it('maps each text by its form in statuses.json, with any place in the brackets, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, '【西溪站】已出库,配送中')).toBe('out_for_delivery');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(wlkgoStage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(wlkgoStage('新的状态')).toBeNull();
  });
});

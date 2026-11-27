import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HD_EXPRESS_API, HD_EXPRESS_SITE, HdExpressTracker, hdExpressLookupUrl } from './adapter.js';
import { normalizeHdExpressNumber, parseHdExpress } from './parser.js';
import { hdExpressStage, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'HDC99999999999';
// After the sample's newest row.
const READ_AT = Date.parse('2026-11-27T12:00:00Z');
const text = (name: 'cleared' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: 'cleared' | 'not-found') => JSON.parse(text(name)) as { msg: string; code: number; data: Record<string, unknown>[] };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json;charset=utf-8' }, ...init });

describe('HD Express tracking lookup', () => {
  it('asks the service for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('cleared')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const spaced = `${NUMBER.slice(0, 3).toLowerCase()} ${NUMBER.slice(3, 9)}-${NUMBER.slice(9)}`;
    const result = await new HdExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(spaced, { budgetMs: 5000 });
    expect(result.events).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(hdExpressLookupUrl(NUMBER));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(HD_EXPRESS_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ waybillNo: NUMBER });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: HD_EXPRESS_SITE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hd-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, on Vancouver\'s clock until the parcel leaves and on China\'s after, with ZTO\'s hand-off', () => {
    const result = parseHdExpress(json('cleared'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: '清关完毕', last_update: '2022-12-28T17:21:16+08:00', last_update_local: '2022-12-28T17:21:16',
      expected_delivery: null, destination_country: 'CN', delivery_carrier: 'zto', delivery_tracking_number: '73194550922032' });
    const events = result.events!;
    expect(events.map((event) => [event.provider_code, event.time_zone, event.time_zone_basis])).toEqual([
      ['7', 'Asia/Shanghai', 'destination'], ['5', 'Asia/Shanghai', 'destination'], ['4', 'Asia/Shanghai', 'destination'],
      ['3', 'America/Vancouver', 'carrier'], ['2', 'America/Vancouver', 'carrier'], ['1', 'America/Vancouver', 'carrier'],
    ]);
    expect(events[1]).toEqual({ time: '2022-12-17T07:35:14+08:00', time_zone: 'Asia/Shanghai', time_zone_basis: 'destination',
      local_time: '2022-12-17T07:35:14', description: '快件已到达海关,清关中', original_description: '快件已到达海关,清关中(中通单号：73194550922032)',
      provider_code: '5', stage: 'customs', stage_source: 'carrier_map' });
    expect(events[2]).toMatchObject({ time: '2022-12-10T10:44:01+08:00', description: '快件已发往国内', stage: 'in_transit' });
    expect(events[3]).toEqual({ time: '2022-12-07T08:26:08-08:00', time_zone: 'America/Vancouver', time_zone_basis: 'carrier',
      local_time: '2022-12-07T08:26:08', description: '快件中心已揽收', provider_code: '3', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events[4]).toMatchObject({ description: '分店已收件', stage: 'accepted' });
    expect(events[5]).toMatchObject({ time: '2022-12-06T13:42:14-08:00', description: '运单创建成功', stage: 'registered' });
    // The departure for China comes after the centre's collection on both clocks.
    expect(Date.parse(events[2]!.time!)).toBeGreaterThan(Date.parse(events[3]!.time!));
    expect(result).not.toHaveProperty('location');
  });

  it('names ZTO only with a waybill a row gives as ZTO\'s, not with the courier number the page shows unnamed', () => {
    const payload = json('cleared');
    const without = { ...payload, data: payload.data.map((row) => ({ ...row, description: String(row.description).replace(/\(中通单号：\d+\)/, '') })) };
    const result = parseHdExpress(without, NUMBER, READ_AT);
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result.events![1]).not.toHaveProperty('original_description');
    // A number ZTO's rules do not take stays in the wording.
    const odd = { ...payload, data: payload.data.map((row) => ({ ...row, description: String(row.description).replace('73194550922032', '123') })) };
    expect(parseHdExpress(odd, NUMBER, READ_AT)).not.toHaveProperty('delivery_carrier');
  });

  it('keeps only the rows for the whole number asked, and before the departure, every row on Vancouver\'s clock', () => {
    const payload = json('cleared');
    const mixed = { ...payload, data: [...payload.data, { ...payload.data[0]!, id: 1, waybillNo: 'HDC22120600015' }] };
    expect(parseHdExpress(mixed, NUMBER, READ_AT).events).toHaveLength(6);
    const early = { ...payload, data: payload.data.filter((row) => (row.state as number) <= 3) };
    const result = parseHdExpress(early, NUMBER, READ_AT);
    expect(result.events!.every((event) => event.time_zone === 'America/Vancouver')).toBe(true);
    expect(result).toMatchObject({ current_stage: 'in_transit' });
    expect(result).not.toHaveProperty('destination_country');
  });

  it('leaves a row the zone would date after the lookup its wall clock alone', () => {
    const result = parseHdExpress(json('cleared'), NUMBER, Date.parse('2022-12-28T08:00:00Z'));
    expect(result.events![0]).toEqual({ local_time: '2022-12-28T17:21:16', description: '清关完毕', provider_code: '7',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result).toMatchObject({ last_update: null, last_update_local: '2022-12-28T17:21:16' });
  });

  it('reads the empty answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHdExpress(json('not-found'), UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHdExpress(json('cleared'), 'HDC22120600015', READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHdExpress({ ...json('not-found'), msg: '失败' }, UNKNOWN, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHdExpress({ msg: '登录失效', code: 1001, data: null }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHdExpress({ msg: '成功', code: 0 }, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const payload = json('cleared');
    const clock = { ...payload, data: payload.data.map((row) => ({ ...row, updateTime: '2022-12-32 17:21:16.0' })) };
    expect(() => parseHdExpress(clock, NUMBER, READ_AT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const blank = { ...payload, data: payload.data.map((row) => ({ ...row, description: '' })) };
    expect(() => parseHdExpress(blank, NUMBER, READ_AT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new HdExpressTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('cleared'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.hdc-express.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts a waybill shape only, without a request', async () => {
    expect(normalizeHdExpressNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['HDC123', 'HDCABCDEFGHIJK', `HDC${'1'.repeat(30)}`, 'HDC2212/0600014', '']) {
      expect(() => normalizeHdExpressNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HdExpressTracker({ fetcher }).fetch('HDC123')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new HdExpressTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hd-express', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('detects HDC and eleven digits only', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'hd-express', confidence: 'high' });
    for (const number of ['HDC2212060001', 'HDC221206000140', 'HDX22120600014']) expect(detectCarrierMatch(number).carrier, number).not.toBe('hd-express');
  });

  it('maps the rows by their step and wording, else by the shared wording rules', () => {
    expect(hdExpressStage('分店已收件', '2')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(hdExpressStage('快件已到达海关,清关中', '5')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(statusMap.stage('7', '清关完毕')).toBe('in_transit');
    expect(statusMap.stage(null, '清关完毕')).toBeUndefined();
    expect(hdExpressStage('已签收', '9')).toMatchObject({ stage: 'delivered' });
  });
});

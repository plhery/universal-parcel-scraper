import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SUTONGST_API, SutongstTracker, sutongstLookupUrl } from './adapter.js';
import { normalizeSutongstNumber, parseSutongst, placeClock, sutongstText } from './parser.js';
import { statusMap, sutongstStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = numbers.records[0]!.number;
const UNKNOWN = 'ST999990000017';
const READ_AT = Date.parse('2026-11-28T12:00:00Z');
type Name = 'delivered' | 'not-found';
type Row = { time: string; context: string };
type Reply = Record<string, unknown> & { data: Row[] };
const text = (name: Name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const json = (name: Name) => JSON.parse(text(name)) as Reply;
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/json; Charset=utf-8' }, ...init });

describe('Sutong International Express tracking lookup', () => {
  it('asks the route for the whole number with the page\'s fixed inputs through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new SutongstTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' })
      .fetch(` ${NUMBER.slice(0, 6)}-${NUMBER.slice(6)} `.toLowerCase(), { budgetMs: 5000 });
    expect(result.events).toHaveLength(13);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SUTONGST_API}?id=SUTONG&com=88889&nu=${NUMBER}`);
    expect(sutongstLookupUrl('ST1&x=2')).toBe(`${SUTONGST_API}?id=SUTONG&com=88889&nu=ST1%26x%3D2`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sutongst', step: 'direct', outcome: 'ok' }));
  });

  it('reads the sample newest first, Shenzhen on China\'s clock, California on its own and the rest as wall clocks, without the signer', () => {
    const result = parseSutongst(json('delivered'), NUMBER, READ_AT);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: '[Ontario]Have been delivered', last_update: null, last_update_local: '2026-11-19T16:59:24',
      expected_delivery: null, destination_country: 'US' });
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map((event) => [event.local_time, event.time ?? null, event.location ?? null, event.description, event.stage])).toEqual([
      ['2026-11-19T16:59:24', null, 'Ontario', '[Ontario]Have been delivered', 'delivered'],
      ['2026-11-19T13:51:51', null, 'Ontario', '[Ontario]Loaded and waiting for delivery', 'out_for_delivery'],
      ['2026-11-18T18:10:45', '2026-11-18T18:10:45-08:00', 'California', '[California]Delivery of global express vehicles to the next stop locally', 'in_transit'],
      ['2026-11-17T11:32:17', '2026-11-17T11:32:17-08:00', 'California', '[California]Arrive at the destination sorting center', 'in_transit'],
      ['2026-11-16T15:48:52', '2026-11-16T15:48:52-08:00', 'California', '[California]International Cargo Release - Export', 'in_transit'],
      ['2026-11-14T10:39:54', '2026-11-14T10:39:54-08:00', 'California', '[California]Customs clearance, waiting for customs clearance commodity inspection', 'customs'],
      ['2026-11-13T19:44:51', '2026-11-13T19:44:51-08:00', 'California', '[California]Arrival on scan', 'in_transit'],
      ['2026-11-11T05:21:47', null, null, '【中国-US】国际运输中', 'in_transit'],
      ['2026-11-10T21:45:54', '2026-11-10T21:45:54+08:00', '深圳', '【深圳】离开转运中心', 'in_transit'],
      ['2026-11-10T08:28:55', '2026-11-10T08:28:55+08:00', '深圳', '【深圳】正在安排下一站转运', 'in_transit'],
      ['2026-11-09T16:40:08', '2026-11-09T16:40:08+08:00', '深圳', '【深圳】 国际货运放行-出口', 'in_transit'],
      ['2026-11-08T21:39:55', '2026-11-08T21:39:55+08:00', '深圳', '【深圳】到达深圳国际函运处理中心', 'accepted'],
      ['2026-11-08T17:20:43', '2026-11-08T17:20:43+08:00', '深圳营业点', '【深圳营业点】订单已处理： 为揽件准备就绪', 'registered'],
    ]);
    expect(result.events![2]).toMatchObject({ time_zone: 'America/Los_Angeles', time_zone_basis: 'place' });
    expect(result.events![8]).toMatchObject({ time_zone: 'Asia/Shanghai', time_zone_basis: 'place' });
    expect(result.events![0]).not.toHaveProperty('time_zone');
    expect(JSON.stringify(result)).not.toMatch(/\*|Delivered \S/);
  });

  it('chooses a row\'s clock from its place only when the place names one zone', () => {
    expect(placeClock('深圳')).toEqual({ zone: 'Asia/Shanghai', country: 'CN' });
    expect(placeClock('California')).toEqual({ zone: 'America/Los_Angeles', country: 'US' });
    expect(placeClock('New York')).toEqual({ zone: 'America/New_York', country: 'US' });
    expect(placeClock('British Columbia')).toEqual({ zone: 'America/Vancouver', country: 'CA' });
    for (const place of ['Ontario', '中国-US', 'Los Angeles', 'Unknown']) expect(placeClock(place), place).toBeNull();
  });

  it('dates a row a zone would put after the lookup on its wall clock alone', () => {
    const payload = json('delivered');
    const result = parseSutongst({ ...payload, data: [{ time: '2026-11-28 21:00:00', context: '【深圳】离开转运中心' }] }, NUMBER, READ_AT);
    expect(result.events![0]).toEqual({ local_time: '2026-11-28T21:00:00', location: '深圳', description: '【深圳】离开转运中心',
      stage: 'in_transit', stage_source: 'carrier_map' });
  });

  it('hands the parcel to the local carrier only when the catalog has it and its rules offer the number', () => {
    const payload = json('delivered');
    const handed = (localCarrier: string, localNumber: string) => parseSutongst({ ...payload, localCarrier, localNumber }, NUMBER, READ_AT);
    expect(handed('USPS', '9400111899223197428490')).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9400111899223197428490' });
    expect(handed('2', '1')).not.toHaveProperty('delivery_carrier');
    expect(handed('USPS', '1234')).not.toHaveProperty('delivery_carrier');
    expect(handed('Some Courier', '9400111899223197428490')).not.toHaveProperty('delivery_carrier');
  });

  it('takes the signer and phones out of a row and keeps its place', () => {
    expect(sutongstText('[Ontario]Have been delivered, Delivered Some Person')).toBe('[Ontario]Have been delivered');
    expect(sutongstText('[Ontario]Delivered Some Person')).toBe('[Ontario]Delivered');
    expect(sutongstText('【深圳】派送中，派送员电话 13800000000')).toBe('【深圳】派送中');
    expect(sutongstText('[California]Customs clearance, waiting for inspection')).toBe('[California]Customs clearance, waiting for inspection');
  });

  it('reads the tracker\'s unknown-number answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseSutongst(json('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const notFound = json('not-found');
    expect(() => parseSutongst({ ...notFound, LatestState: 'InTransit' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSutongst({ ...notFound, status: '1' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSutongst({ ...json('delivered'), status: '0' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSutongst({ status: '0', LatestState: 'NotFound' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSutongst({ ...json('delivered'), data: [{ time: '2026-11-19 25:00:00', context: '[Ontario]x' }] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSutongst({ ...json('delivered'), data: [{ time: '2026-11-19 16:00:00', context: 7 }] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new SutongstTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(UNKNOWN, { budgetMs: 5000 });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(`\uFEFF${text('not-found')}`)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.sutongst.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>', { headers: { 'content-type': 'text/html' } })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<!DOCTYPE html><html><title>香港速通国际物流有限公司</title></html>', { headers: { 'content-type': 'text/html' } }))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('accepts letters and digits only, one number, without a request', async () => {
    expect(normalizeSutongstNumber(NUMBER.toLowerCase())).toBe(NUMBER);
    for (const number of ['ST653', 'SUTONGST', `ST${'6'.repeat(30)}`, `${NUMBER},${UNKNOWN}`, '']) {
      expect(() => normalizeSutongstNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SutongstTracker({ fetcher }).fetch('ST653&nu=1')).rejects.toMatchObject({ kind: 'invalid_input' });
    const controller = new AbortController();
    controller.abort();
    await expect(new SutongstTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'sutongst', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('offers Sutong for ST and twelve digits', () => {
    for (const record of numbers.records) expect(detectCarrierMatch(record.number)).toMatchObject({ confidence: 'low', candidates: ['sutongst'] });
    expect(detectCarrierMatch('ST65338157295').candidates).not.toContain('sutongst');
  });

  it('maps each text in statuses.json, whatever its place, else by the shared wording rules', () => {
    for (const entry of statuses.entries) expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    expect(statusMap.stage(null, normalizeStatusWording('[Texas]Arrival on scan'))).toBe('in_transit');
    expect(statusMap.stage(null, normalizeStatusWording('【广州】离开转运中心'))).toBe('in_transit');
    expect(statusMap.stage(null, '新的状态')).toBeUndefined();
    expect(sutongstStage('已签收')).toMatchObject({ stage: 'delivered' });
    expect(sutongstStage('新的状态')).toBeNull();
  });
});

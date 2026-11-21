import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ANSERX_API } from '../anserx/adapter.js';
import { adapter, DoraGateTracker } from './adapter.js';
import { normalizeDoraGateNumber, parseDoraGate } from './parser.js';
import { doraGateStage, statusMap } from './status.js';

const NUMBER = 'DOR0232840364CN';
const UNKNOWN = 'DOR0000000000CN';
interface Row { waybillNo: unknown; trackingTime: unknown; trackingType: unknown; trackingCode: unknown }
interface Reply { code: number; data: { list: { waybillNo: unknown; deliveryNo: unknown; tksTrackingDetailDTOList: Row[] }[] } }
const raw = (name: 'delivered' | 'not-found') => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: 'delivered' | 'not-found') => JSON.parse(raw(name)) as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'application/json;charset=UTF-8' }, ...init });

describe('Dora Gate tracking lookup', () => {
  it('asks AnserX\'s tracker for the whole waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new DoraGateTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' dor 0232-8403-64 cn ', { budgetMs: 5000 });
    expect(result.status).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(ANSERX_API);
    expect(Object.fromEntries(asked.searchParams)).toEqual({ nos: NUMBER, internalFlag: '0' });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dora-gate', step: 'direct', outcome: 'ok' }));
  });

  it('reads AnserX\'s scans on Beijing time and USPS\'s relayed scans on their own clock', () => {
    const result = parseDoraGate(fixture('delivered'), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null,
      last_update_local: '2026-11-19T11:33:24', expected_delivery: null, destination_country: 'US',
      delivery_tracking_number: '9214490416422202355496' });
    expect(result.events).toHaveLength(25);
    // USPS says the delivery was "at 11:33 am" in Mississippi; the row is relayed as 11:33, without an offset.
    expect(result.events![0]).toMatchObject({ local_time: '2026-11-19T11:33:24', location: 'VANCLEAVE, MS, US', stage: 'delivered' });
    expect(result.events![0]).not.toHaveProperty('time');
    const own = result.events!.filter((event) => event.provider_code);
    expect(own).toHaveLength(9);
    expect(own.every((event) => event.time && event.time_zone === 'Asia/Shanghai')).toBe(true);
    expect(result.events!.filter((event) => !event.provider_code).every((event) => !event.time)).toBe(true);
    expect(result.events!.find((event) => event.provider_code === 'BTY_CLEARANCE_IN_PROGRESS')).toMatchObject({ stage: 'customs', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-11-09T17:28:32', provider_code: 'BTY_ORDER_CREATED', stage: 'registered', location: 'CN' });
    // The customer's account code and order reference are never kept.
    expect(JSON.stringify(result)).not.toMatch(/C001B374|19041017790692/);
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseDoraGate(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDoraGate(changed((r) => { r.data.list[0]!.waybillNo = UNKNOWN; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDoraGate(changed((r) => { r.code = 500; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', provider: 'Dora Gate' }));
    expect(() => parseDoraGate(changed((r) => { r.data.list[0]!.tksTrackingDetailDTOList[0]!.trackingTime = '2026-11-31 11:33:24'; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDoraGate(changed((r) => { r.data.list[0]!.tksTrackingDetailDTOList = []; }), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    const lookup = (body: string, init?: ResponseInit) => new DoraGateTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(NUMBER, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(raw('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://oms.anserx.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>Just a moment...</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('{"code":403}', { status: 403 })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema', provider: 'Dora Gate' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the service', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('delivered')));
    await expect(new DoraGateTracker({ fetcher: flaky }).fetch(NUMBER, { budgetMs: 5000 })).resolves.toMatchObject({ destination_country: 'US' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeDoraGateNumber('dor0232840364cn')).toBe(NUMBER);
    for (const number of ['DOR023284036CN', 'DOR02328403645CN', 'DOR0232840364US', 'DOX0232840364CN', 'BTYCN0232840364YQ', 'LA123456789CN']) {
      expect(() => normalizeDoraGateNumber(number)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new DoraGateTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(new DoraGateTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'dora-gate', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('maps the tracker\'s codes and leaves relayed wordings to the shared rules', () => {
    expect(doraGateStage('BTY_WAREHOUSE_INBOUND', 'Shipment inbound in sorting center')).toEqual({ stage: 'accepted', source: 'carrier_map' });
    expect(doraGateStage('BTY_DEST_TRANSIT', 'Arrived at Transit Facility')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(doraGateStage('', 'Out for Delivery')).toMatchObject({ stage: 'out_for_delivery' });
    expect(statusMap.stage('BTY_CLEARANCE_COMPLETED', '')).toBe('in_transit');
    expect(statusMap.stage('BTY_UNSEEN', '')).toBeUndefined();
  });
});

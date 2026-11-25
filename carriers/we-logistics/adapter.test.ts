import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, WE_LOGISTICS_API, WE_LOGISTICS_CALLBACK, WeLogisticsTracker, weLogisticsLookupUrl } from './adapter.js';
import { normalizeWeLogisticsNumber, parseWeLogistics } from './parser.js';
import { statusMap, weLogisticsStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from an archived capture of ParcelPanel's page for the line, and the number of the line abroad
// its record holds.
const SAMPLE = 'WELBB1000004995YQ';
const CHANNEL = 'ILZXD80000047555';
type Name = 'delivered' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; shipper_hawbcode: unknown; channel_hawbcode: unknown;
  details: { track_occur_date: unknown; track_location: unknown; track_description_en: unknown; track_description: unknown; gmt_offset?: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), WE_LOGISTICS_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('WE Logistics numbers', () => {
  it('offers no carrier for the waybill alone and reads the number out of a link to its tracking page', () => {
    expect(detectCarrierMatch(SAMPLE)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://shgj.rtb56.com/track_query.aspx?track_number=${SAMPLE}`))
      .toMatchObject({ trackingNumber: SAMPLE, carrier: 'we-logistics' });
  });
});

describe('WE Logistics tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new WeLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' welbb 1000004995-yq ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(weLogisticsLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(WE_LOGISTICS_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: WE_LOGISTICS_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'we-logistics', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel collected in Israel, the line’s Shenzhen rows at their stated offset and the rest on wall clocks', () => {
    const result = parseWeLogistics(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package delivered', last_update: null, last_update_local: '2026-07-24T10:57:37',
      expected_delivery: null, destination_country: 'IL', delivery_tracking_number: CHANNEL });
    // The reply names no carrier for the line abroad.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events!.map(({ local_time: local, time, location, description, stage }) => [local ?? time, location, description, stage])).toEqual([
      ['2026-07-24T10:57:37', undefined, 'Package delivered', 'delivered'],
      ['2026-07-24T08:41:15', 'קרית שמונה', 'Arrived at pick-up point. Package available for collection.', 'ready_for_pickup'],
      ['2026-07-22T09:09:54', 'קרית שמונה', 'Arrived at pick-up point. Package available for collection.', 'ready_for_pickup'],
      ['2026-07-22T06:14:55', 'קרית שמונה', 'Received by local delivery company', 'in_transit'],
      ['2026-07-20T14:32:41', 'קרית שמונה', 'Received by local delivery company', 'in_transit'],
      ['2026-07-20T14:17:08', undefined, 'Import customs clearance complete', 'in_transit'],
      ['2026-07-17T22:00:50', undefined, 'Import customs clearance started', 'customs'],
      ['2026-07-16T16:45:59', undefined, 'Flight arrived', 'in_transit'],
      ['2026-07-16T16:45:00', undefined, 'Arrival to the destination airport', 'in_transit'],
      ['2026-07-16T11:30:37', undefined, 'Flight departed', 'in_transit'],
      ['2026-07-16T11:29:00', undefined, 'Departure from the original airport', 'in_transit'],
      ['2026-07-12T11:19:58', undefined, 'Waiting for the flight to take off', 'in_transit'],
      ['2026-07-11T22:00:00', undefined, 'Hand over to airline.', 'in_transit'],
      ['2026-07-07T17:32:39', 'HONG KONG - HONG KONG', 'Depart from facility to service provider.', 'in_transit'],
      ['2026-07-07T15:21:16', 'HONG KONG - HONG KONG', 'Shipment arrived at facility and measured.', 'in_transit'],
      ['2026-07-07T15:21:15', 'HONG KONG - HONG KONG', 'Shipment picked up.', 'in_transit'],
      ['2026-07-03T08:51:57', 'HONG KONG', 'handover to the airline', 'in_transit'],
      ['2026-07-02T08:51:57', 'HONG KONG', 'transit to Airport', 'in_transit'],
      ['2026-06-30T09:00:59', undefined, 'Parcel information received', 'in_transit'],
      ['2026-06-29T20:10:01', '深圳总部', '深圳总部', 'in_transit'],
      ['2026-06-26T11:17:45+08:00', '深圳', 'Shipment departed from facility', 'in_transit'],
      ['2026-06-26T10:49:24+08:00', '深圳', 'Shenzhen,Shipment arrived at facility', 'accepted'],
      ['2026-06-15T10:12:46+08:00', undefined, 'Shipment information received', 'registered'],
    ]);
    expect(result.events!.slice(0, -3).every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events!.every((event) => !event.provider_code)).toBe(true);
    // The merchant's reference is never read.
    expect(JSON.stringify(result)).not.toMatch(/0000000000/);
  });

  it('keeps the number of the line abroad without naming a carrier, and only when it is another number', () => {
    const onward = (channel: string) => parseWeLogistics(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), SAMPLE);
    expect(onward('1Z999AA10123456784')).toMatchObject({ delivery_tracking_number: '1Z999AA10123456784' });
    expect(onward('1Z999AA10123456784')).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', SAMPLE, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('keeps the wall clock of a row that states no valid offset', () => {
    const result = parseWeLogistics(changed((reply) => { for (const row of reply.data[0]!.details) row.gmt_offset = ''; }), SAMPLE);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(parseWeLogistics(changed((reply) => { reply.data[0]!.details.at(-1)!.gmt_offset = '+8'; }), SAMPLE).events!.at(-1))
      .toMatchObject({ local_time: '2026-06-15T10:12:46' });
  });

  it('reads only the entry whose waybill is the number asked', () => {
    // The lookup also finds a parcel by the merchant's reference or the number of the line abroad.
    const elsewhere = changed((reply) => {
      reply.data[0]!.server_hawbcode = CHANNEL;
      reply.data[0]!.channel_hawbcode = SAMPLE;
    });
    expect(() => parseWeLogistics(elsewhere, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWeLogistics(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseWeLogistics(changed((r) => { r.data[0]!.server_hawbcode = SAMPLE.toLowerCase(); }), SAMPLE)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseWeLogistics(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseWeLogistics(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWeLogistics({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWeLogistics(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseWeLogistics(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-07-24 25:57:37'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new WeLogisticsTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(SAMPLE, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(raw('delivered'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>验证码</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the tracker', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('delivered')));
    await expect(new WeLogisticsTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeWeLogisticsNumber('welbb1000004995yq')).toBe(SAMPLE);
    for (const number of ['1000004995', 'WELBB1000004995', 'WELBB100000499YQ', 'WELBB10000049950YQ', 'WEBB1000004995YQ', 'WELB11000004995YQ', CHANNEL, 'ZZ0000000000ZZ']) {
      expect(() => normalizeWeLogisticsNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new WeLogisticsTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'we-logistics', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('recognizes by the same lookup', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    await expect(adapter({ fetcher: known, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toMatchObject({ known: true });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toEqual({ known: false });
  });

  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(weLogisticsStage('Import customs clearance started')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(weLogisticsStage('快件操作完成')).toBeNull();
    expect(statusMapAnswer({ carrier: 'we-logistics', description: 'Arrived at pick-up point. Package available for collection.' }))
      .toEqual({ kind: 'mapped', stage: 'ready_for_pickup' });
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, XYS_API, XYS_CALLBACK, XysTracker, xysLookupUrl } from './adapter.js';
import { normalizeXysNumber, parseXys } from './parser.js';
import { statusMap, xysStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from an archived capture of ParcelPanel's XYS Logistics page, and DHL's number its record holds.
const SAMPLE = 'XYS106664200CN';
const ONWARD = '00340435072417334367';
type Name = 'delivered' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; shipper_hawbcode: unknown; channel_hawbcode: unknown;
  details: { track_occur_date: unknown; track_description_en: unknown; track_description: unknown; gmt_offset?: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), XYS_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('XYS Logistics numbers', () => {
  it('offers no carrier for the waybill alone and reads the number out of a link to its tracking page', () => {
    expect(detectCarrierMatch(SAMPLE)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://szxys.rtb56.com/track_query.aspx?track_number=${SAMPLE}`))
      .toMatchObject({ trackingNumber: SAMPLE, carrier: 'xys-logistics' });
  });
});

describe('XYS Logistics tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new XysTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' xys 106664200-cn ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(xysLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(XYS_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: XYS_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'xys-logistics', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel DHL delivered on its scans’ wall clocks, each repeated row once', () => {
    const result = parseXys(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-07-16T15:15:00',
      expected_delivery: null, destination_country: 'DE', delivery_carrier: 'dhl', delivery_tracking_number: ONWARD });
    expect(result.events!.map(({ local_time: local, location, description, stage }) => [local, location, description, stage])).toEqual([
      ['2026-07-16T15:15:00', 'DE', 'Delivered', 'delivered'],
      ['2026-07-16T09:04:00', undefined, 'Out of delivery', 'out_for_delivery'],
      ['2026-07-16T05:59:00', 'DE', 'Out of delivery', 'out_for_delivery'],
      ['2026-07-15T17:58:00', 'DE', 'Shipment been picked up by the destination partner', 'in_transit'],
      ['2026-07-14T20:10:00', 'AMS', 'Import customs clearance completed', 'in_transit'],
      ['2026-07-14T19:10:00', 'AMS', 'Import clearance start', 'customs'],
      ['2026-07-13T14:26:00', 'AMS', 'Flight arrival', 'in_transit'],
      ['2026-07-11T17:40:00', 'HKG', 'The flight has taken off from the origin', 'in_transit'],
      ['2026-07-11T03:26:00', 'HKG', 'Handover to airline', 'in_transit'],
      ['2026-07-10T17:00:00', 'HKG', 'Export customs clearance completed', 'in_transit'],
      ['2026-07-09T21:17:25', 'SHENZHEN', 'Has left the warehouse', 'in_transit'],
      ['2026-07-09T19:44:24', 'SHENZHEN', 'Has been put into storage', 'accepted'],
      ['2026-07-06T15:04:53', undefined, 'The waybill has been created; tracking updates upon package receipt.', 'registered'],
    ]);
    expect(result.events!.every((event) => event.local_time && !event.time && !event.provider_code)).toBe(true);
    // The merchant's reference is never read.
    expect(JSON.stringify(result)).not.toMatch(/0000000000000/);
  });

  it('names DHL only for a number its rule claims whole', () => {
    const onward = (channel: string) => parseXys(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), SAMPLE);
    expect(onward('1Z999AA10123456784')).toMatchObject({ delivery_tracking_number: '1Z999AA10123456784' });
    expect(onward('1Z999AA10123456784')).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', SAMPLE, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
      expect(onward(channel), channel).not.toHaveProperty('delivery_carrier');
    }
  });

  it('keeps wall clocks whatever offset a row states', () => {
    const result = parseXys(changed((reply) => { for (const row of reply.data[0]!.details) row.gmt_offset = '+08:00'; }), SAMPLE);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
  });

  it('reads only the entry whose waybill is the number asked', () => {
    // The lookup also finds a parcel by the merchant's reference or the delivering network's number.
    const elsewhere = changed((reply) => {
      reply.data[0]!.server_hawbcode = 'ZZ0000000000ZZ';
      reply.data[0]!.channel_hawbcode = SAMPLE;
    });
    expect(() => parseXys(elsewhere, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXys(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseXys(changed((r) => { r.data[0]!.server_hawbcode = 'xys106664200cn'; }), SAMPLE)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseXys(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseXys(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXys({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseXys(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseXys(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-07-16 25:15:00'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new XysTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
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
    await expect(new XysTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeXysNumber('xys106664200cn')).toBe(SAMPLE);
    for (const number of ['106664200', 'XYS106664200', 'XYS10666420CN', 'XYS1066642000CN', 'XY106664200CN', 'XYS106664200DE', 'ZZ0000000000ZZ']) {
      expect(() => normalizeXysNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new XysTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'xys-logistics', steps: ['direct', 'retry'], recordsSteps: true });
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
    expect(xysStage('Import clearance start')).toEqual({ stage: 'customs', source: 'carrier_map' });
    expect(xysStage('快件操作完成')).toBeNull();
  });
});

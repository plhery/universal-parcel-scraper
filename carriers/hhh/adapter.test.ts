import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, HHH_API, HHH_CALLBACK, HhhTracker, hhhLookupUrl } from './adapter.js';
import { normalizeHhhNumber, parseHhh } from './parser.js';
import { hhhStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples from archived captures of ParcelPanel's HHH page, and the delivering networks' numbers their records hold.
const SAMPLE = 'HHH1001984021YQ';
const LATER = 'HHH1001987474YQ';
const ONWARD = '9261290378010016356614';
const UNIUNI = 'UUS62U0560188642638';
type Name = 'delivered' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; shipper_hawbcode: unknown; channel_hawbcode: unknown;
  details: { track_occur_date: unknown; track_description_en: unknown; track_description: unknown; gmt_offset: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), HHH_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Haihehui International numbers', () => {
  it('offers no carrier for the waybill alone and reads the number out of a link to its tracking page', () => {
    for (const number of [SAMPLE, LATER]) expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://szhhh.rtb56.com/track_query.aspx?track_number=${SAMPLE}`))
      .toMatchObject({ trackingNumber: SAMPLE, carrier: 'hhh' });
  });
});

describe('Haihehui International tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new HhhTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' hhh 1001-984021 yq ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(hhhLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(HHH_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: HHH_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'hhh', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel USPS delivered on its scans’ wall clocks, without USPS’s sentence or postcodes', () => {
    const result = parseHhh(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, Front Door/Porch', last_update: null, last_update_local: '2026-02-17T13:04:00',
      expected_delivery: null, destination_country: 'US', delivery_tracking_number: ONWARD });
    // USPS's rule claims the number only among others, so no partner is named.
    expect(result).not.toHaveProperty('delivery_carrier');
    const events = result.events!;
    expect(events).toHaveLength(13);
    expect(events[0]).toMatchObject({ local_time: '2026-02-17T13:04:00', location: 'BRUNSWICK, GA, US', description: 'Delivered, Front Door/Porch', stage: 'delivered' });
    // USPS's label, made after the line's facility dispatched the parcel, moves nothing.
    expect(events.find(({ description }) => description === 'Shipping Label Created, USPS Awaiting Item'))
      .toEqual({ local_time: '2026-02-07T11:10:00', location: 'US', description: 'Shipping Label Created, USPS Awaiting Item' });
    expect(events.find(({ description }) => description === 'Shipment departed from facility'))
      .toMatchObject({ local_time: '2026-02-07T12:44:54', location: 'SHENZHEN', stage: 'in_transit' });
    expect(events.at(-2)).toMatchObject({ location: 'SHENZHEN', description: 'Shipment arrived at facility', stage: 'accepted' });
    expect(events.at(-1)).toMatchObject({ local_time: '2026-02-03T21:18:51', description: 'Shipment information received', stage: 'registered' });
    expect(events.every((event) => event.local_time && !event.time && !event.provider_code)).toBe(true);
    // The merchant's reference, the recipient's ZIP code and USPS's sentence are never read.
    expect(JSON.stringify(result)).not.toMatch(/XM0000000000|00000|->|porch at/);
  });

  it('names USPS or UniUni only for a number its rule claims whole, and keeps a routing barcode’s package identifier', () => {
    const onward = (channel: string) => parseHhh(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), SAMPLE);
    expect(onward(UNIUNI)).toMatchObject({ delivery_carrier: 'uniuni', delivery_tracking_number: UNIUNI });
    expect(onward('9214490424563600907159')).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9214490424563600907159' });
    expect(onward('420000009214490424563600907159')).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9214490424563600907159' });
    expect(onward('1Z999AA10123456784')).toMatchObject({ delivery_tracking_number: '1Z999AA10123456784' });
    expect(onward('1Z999AA10123456784')).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', SAMPLE, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('keeps wall clocks whatever offset a row states', () => {
    const result = parseHhh(changed((reply) => { for (const row of reply.data[0]!.details) row.gmt_offset = '+08:00'; }), SAMPLE);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result.events![0]).toMatchObject({ local_time: '2026-02-17T13:04:00' });
  });

  it('reads only the entry whose waybill is the number asked', () => {
    // The lookup also finds a parcel by the merchant's reference or the delivering network's number.
    const elsewhere = changed((reply) => {
      reply.data[0]!.server_hawbcode = 'ZZ0000000000ZZ';
      reply.data[0]!.shipper_hawbcode = SAMPLE;
      reply.data[0]!.channel_hawbcode = SAMPLE;
    });
    expect(() => parseHhh(elsewhere, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHhh(changed((r) => { r.data[0]!.server_hawbcode = LATER; }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseHhh(changed((r) => { r.data[0]!.server_hawbcode = 'hhh1001984021yq'; }), SAMPLE)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHhh(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHhh(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHhh(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHhh({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHhh(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseHhh(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-02-30 13:04:00'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHhh(changed((r) => { r.data[0]!.details[0]!.track_description_en = 42; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new HhhTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
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
    await expect(new HhhTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeHhhNumber('hhh1001984021yq')).toBe(SAMPLE);
    for (const number of ['1001984021', 'HHH1001984021', 'HHH100198402YQ', 'HHH10019840210YQ', 'HH1001984021YQ', 'HHH1001984021YA', 'ZZ0000000000ZZ']) {
      expect(() => normalizeHhhNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HhhTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'hhh', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('recognizes by the same lookup', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    await expect(adapter({ fetcher: known, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toMatchObject({ known: true });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toEqual({ known: false });
  });

  it('maps every wording it lists, and leaves the delivering networks’ order records unstaged', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe('unmapped' in entry ? undefined : entry.stage);
    }
    expect(statusMap.gaps.map(({ wording }) => wording)).toEqual(['shipping label created, usps awaiting item', 'order received']);
    expect(hhhStage('Shipping Label Created, USPS Awaiting Item')).toBeNull();
    expect(hhhStage('Out for delivery')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(hhhStage('快件操作完成')).toBeNull();
  });
});

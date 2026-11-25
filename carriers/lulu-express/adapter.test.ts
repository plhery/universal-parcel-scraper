import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, LULU_EXPRESS_API, LULU_EXPRESS_CALLBACK, LuluExpressTracker, luluExpressLookupUrl } from './adapter.js';
import { normalizeLuluExpressNumber, parseLuluExpress } from './parser.js';
import { luluExpressStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from an archived capture of ParcelPanel's lulu page.
const SAMPLE = 'LULU1000674156';
const ONWARD = '9259764497059973570287';
type Name = 'delivered' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; shipper_hawbcode: unknown; channel_hawbcode: unknown;
  details: { track_occur_date: unknown; track_description_en: unknown; track_description: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), LULU_EXPRESS_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('luluExpress numbers', () => {
  it('offers no carrier for the waybill alone and reads the number out of a link to its tracking page', () => {
    expect(detectCarrierMatch(SAMPLE).candidates ?? []).not.toContain('lulu-express');
    expect(parseTrackingInput(`http://szcxsd.rtb56.com/track_query.aspx?track_number=${SAMPLE}`))
      .toMatchObject({ trackingNumber: SAMPLE, carrier: 'lulu-express' });
  });
});

describe('luluExpress tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new LuluExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' lulu 1000-674156 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(luluExpressLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(LULU_EXPRESS_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: LULU_EXPRESS_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'lulu-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel USPS delivered, on the offsets its scans state, without USPS’s sentence or postcodes', () => {
    const result = parseLuluExpress(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, In/At Mailbox', last_update: '2026-06-20T15:27:00-04:00', expected_delivery: null,
      destination_country: 'US', delivery_tracking_number: ONWARD });
    // USPS's rule claims the number only among others, so no partner is named.
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(result.events).toHaveLength(26);
    expect(result.events![0]).toMatchObject({ location: 'DALLAS, GA', description: 'Delivered, In/At Mailbox', stage: 'delivered' });
    expect(result.events!.slice(7, 9).map(({ time, description }) => [time, description])).toEqual([
      ['2026-06-18T16:00:00-04:00', 'Departed USPS Facility'],
      ['2026-06-18T11:38:00-04:00', 'Arrived at USPS Facility'],
    ]);
    expect(result.events!.find((event) => event.description === 'Shipment in transit')).toMatchObject({ time: '2026-06-11T23:36:25+08:00', stage: 'in_transit' });
    expect(result.events!.at(-2)).toMatchObject({ location: 'SHENZHEN', description: 'Shipment arrived at facility', stage: 'accepted' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-06-03T09:44:11+08:00', description: 'Shipment information received', stage: 'registered' });
    expect(result.events!.every((event) => event.time && !event.local_time && !event.provider_code && event.stage)).toBe(true);
    // The merchant's reference, the recipient's ZIP code and USPS's sentence are never read.
    expect(JSON.stringify(result)).not.toMatch(/XM0000000000|00000|30213|->|mailbox at/);
  });

  it('names USPS only for a number its rule claims whole, and keeps a routing barcode’s package identifier', () => {
    const onward = (channel: string) => parseLuluExpress(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), SAMPLE);
    expect(onward('9214490424563600907159')).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9214490424563600907159' });
    expect(onward('420000009214490424563600907159')).toMatchObject({ delivery_carrier: 'usps', delivery_tracking_number: '9214490424563600907159' });
    expect(onward('1Z999AA10123456784')).toMatchObject({ delivery_tracking_number: '1Z999AA10123456784' });
    expect(onward('1Z999AA10123456784')).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', SAMPLE, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads only the entry whose waybill is the number asked', () => {
    // The lookup also finds a parcel by the merchant's reference or the delivering network's number.
    const elsewhere = changed((reply) => {
      reply.data[0]!.server_hawbcode = 'ZZ0000000000ZZ';
      reply.data[0]!.shipper_hawbcode = SAMPLE;
      reply.data[0]!.channel_hawbcode = SAMPLE;
    });
    expect(() => parseLuluExpress(elsewhere, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLuluExpress(changed((r) => { r.data[0]!.server_hawbcode = 'LULU10006741567'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseLuluExpress(changed((r) => { r.data[0]!.server_hawbcode = 'lulu1000674156'; }), SAMPLE)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseLuluExpress(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseLuluExpress(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLuluExpress(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLuluExpress({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLuluExpress(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseLuluExpress(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-06-31 15:27:00'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLuluExpress(changed((r) => { r.data[0]!.details[0]!.track_description_en = 42; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new LuluExpressTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
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
    await expect(new LuluExpressTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeLuluExpressNumber('lulu1000674156')).toBe(SAMPLE);
    for (const number of ['1000674156', 'LULU100067415', 'LULU10006741560', 'LUL1000674156', 'LULU100067415A', 'ZZ0000000000ZZ']) {
      expect(() => normalizeLuluExpressNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new LuluExpressTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'lulu-express', steps: ['direct', 'retry'], recordsSteps: true });
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
    expect(statusMap.gaps).toEqual([]);
    expect(luluExpressStage('仓库作业')).toBeNull();
  });
});

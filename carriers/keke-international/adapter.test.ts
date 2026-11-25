import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, KEKE_API, KEKE_CALLBACK, KekeTracker, kekeLookupUrl } from './adapter.js';
import { normalizeKekeNumber, parseKeke } from './parser.js';
import { kekeStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from an archived capture of ParcelPanel's Keke International page, Team Global Express's number,
// and the line's own waybill its record holds.
const SAMPLE = '816009764533';
const WAYBILL = 'KK11652371';
type Name = 'delivered' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; shipper_hawbcode: unknown; channel_hawbcode: unknown;
  details: { track_occur_date: unknown; track_description_en: unknown; track_description: unknown; track_location: unknown; gmt_offset: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), KEKE_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Keke International numbers', () => {
  it('leaves both numbers to detection, which claims neither, and reads the number out of a link to its tracking page', () => {
    expect(detectCarrierMatch(SAMPLE)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(SAMPLE).candidates).not.toContain('keke-international');
    expect(detectCarrierMatch(WAYBILL).candidates).not.toContain('keke-international');
    expect(parseTrackingInput(`http://ywkk.rtb56.com/track_query.aspx?track_number=${SAMPLE}`))
      .toMatchObject({ trackingNumber: SAMPLE, carrier: 'keke-international' });
  });
});

describe('Keke International tracking lookup', () => {
  it('asks the tenant’s lookup for the whole number without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new KekeTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 8160 0976 4533 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(kekeLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(KEKE_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: KEKE_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'keke-international', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel Team Global Express delivered by its number, on its scans’ wall clocks, with the line’s waybill', () => {
    const result = parseKeke(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Successful delivery', last_update: null, last_update_local: '2026-07-21T12:10:00',
      expected_delivery: null, destination_country: 'AU', canonical_tracking_number: WAYBILL });
    // The number asked is the delivering network's, which no rule claims.
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('delivery_carrier');
    const events = result.events!;
    // Team Global Express's categories beside its scans go.
    expect(events.map(({ local_time: local, location, description, stage }) => [local, location, description, stage])).toEqual([
      ['2026-07-21T12:10:00', 'Randwick, NSW', 'Successful delivery', 'delivered'],
      ['2026-07-21T06:20:00', 'Botany, NSW', 'On for delivery', 'out_for_delivery'],
      ['2026-07-21T02:53:00', 'Botany, NSW', 'Depot scan', 'in_transit'],
      ['2026-07-20T17:21:00', 'Botany, NSW', 'Depot scan', 'in_transit'],
      ['2026-07-20T13:09:00', 'Sydney', 'Into depot', 'in_transit'],
      ['2026-07-20T13:09:00', 'Sydney', 'Linehaul to destination depot: overnight', 'in_transit'],
      ['2026-07-15T19:33:00', 'China', 'Electronic billing transfer', undefined],
      ['2026-07-14T14:44:50', 'YIWU', 'Shipment departed from facility', 'in_transit'],
      ['2026-07-14T14:10:08', 'YIWU', 'Shipment arrived at facility', 'accepted'],
      ['2026-07-12T09:53:14', undefined, 'Shipment information received', 'registered'],
    ]);
    expect(events.every((event) => event.local_time && !event.time && !event.provider_code)).toBe(true);
    // The merchant's reference is never read.
    expect(JSON.stringify(result)).not.toMatch(/XM0000000000/);
  });

  it('reads the same record by the line’s waybill, with the delivering network’s number', () => {
    const reply = changed(() => {});
    expect(parseKeke(reply, WAYBILL)).toMatchObject({ current_stage: 'delivered', delivery_tracking_number: SAMPLE });
    expect(parseKeke(reply, WAYBILL)).not.toHaveProperty('canonical_tracking_number');
    expect(parseKeke(reply, WAYBILL).events).toHaveLength(10);
  });

  it('keeps a category alone and a category with a kind code, and wall clocks whatever offset a row states', () => {
    const alone = parseKeke(changed((reply) => { reply.data[0]!.details.splice(0, 1); }), SAMPLE);
    expect(alone.events![0]).toMatchObject({ local_time: '2026-07-21T12:10:00', description: 'Delivered', stage: 'delivered' });
    const offsets = parseKeke(changed((reply) => { for (const row of reply.data[0]!.details) row.gmt_offset = '+08:00'; }), SAMPLE);
    expect(offsets.events!.every((event) => event.local_time && !event.time)).toBe(true);
  });

  it('reads only the entry whose waybill or delivering network’s number is the number asked', () => {
    // The lookup also finds a parcel by the merchant's reference, which is never read.
    const reference = changed((reply) => { reply.data[0]!.shipper_hawbcode = 'XM1234567890'; });
    expect(() => parseKeke(reference, 'XM1234567890')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKeke(changed((r) => { r.data[0]!.channel_hawbcode = '816009764534'; }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKeke(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKeke(changed((r) => { r.data.push(r.data[0]!); }), WAYBILL)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseKeke(changed((r) => { r.data[0]!.server_hawbcode = 'kk 1165 2371'; }), SAMPLE)).toMatchObject({ canonical_tracking_number: WAYBILL });
  });

  it('names the delivering network only when its rule claims the number whole', () => {
    const onward = (channel: string) => parseKeke(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), WAYBILL);
    expect(onward('1Z999AA10123456784')).toMatchObject({ delivery_tracking_number: '1Z999AA10123456784' });
    expect(onward('1Z999AA10123456784')).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', WAYBILL, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseKeke(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseKeke(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKeke({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseKeke(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseKeke(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-07-32 12:10:00'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseKeke(changed((r) => { r.data[0]!.details[0]!.track_description_en = 42; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new KekeTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
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
    await expect(new KekeTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('refuses what is no tracking number without a request', async () => {
    expect(normalizeKekeNumber('kk1165-2371')).toBe(WAYBILL);
    for (const number of ['1165237', 'KKKKKKKKKK', `${SAMPLE},${WAYBILL}`, 'https://example.invalid/x']) {
      expect(() => normalizeKekeNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new KekeTracker({ fetcher }).fetch('KK')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'keke-international', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('recognizes by the same lookup', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    await expect(adapter({ fetcher: known, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toMatchObject({ known: true });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toEqual({ known: false });
  });

  it('maps every wording it lists, and leaves the delivering network’s order records unstaged', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe('unmapped' in entry ? undefined : entry.stage);
    }
    expect(statusMap.gaps.map(({ wording }) => wording)).toEqual(['electronic billing transfer', 'shipment created']);
    expect(kekeStage('Electronic billing transfer')).toBeNull();
    expect(kekeStage('Successful delivery')).toEqual({ stage: 'delivered', source: 'carrier_map' });
    expect(kekeStage('快件操作完成')).toBeNull();
  });
});

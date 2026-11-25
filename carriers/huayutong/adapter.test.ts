import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, HUAYUTONG_API, HUAYUTONG_CALLBACK, HuayutongTracker, huayutongLookupUrl } from './adapter.js';
import { normalizeHuayutongNumber, parseHuayutong } from './parser.js';
import { huayutongStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample from an archived capture of ParcelPanel's HYT page.
const SAMPLE = 'JCY0806041625DH';
type Name = 'delivered' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; shipper_hawbcode: unknown; channel_hawbcode: unknown;
  details: { track_occur_date: unknown; track_description_en: unknown; track_description: unknown; gmt_offset: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), HUAYUTONG_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('delivered'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('Huayutong numbers', () => {
  it('offers no carrier for the waybill alone and reads the number out of a link to its tracking page', () => {
    expect(detectCarrierMatch(SAMPLE)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://szhyt.rtb56.com/track_query.aspx?track_number=${SAMPLE}`))
      .toMatchObject({ trackingNumber: SAMPLE, carrier: 'huayutong' });
  });
});

describe('Huayutong tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new HuayutongTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jcy 0806041625-dh ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(huayutongLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(HUAYUTONG_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: HUAYUTONG_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'huayutong', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel delivered in Britain on its scans’ wall clocks, whatever offset they state', () => {
    const result = parseHuayutong(fixture('delivered'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Your express has been delivered', last_update: null, last_update_local: '2025-09-03T15:43:16',
      expected_delivery: null, destination_country: 'GB' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('delivery_carrier');
    const events = result.events!;
    expect(events).toHaveLength(17);
    expect(events.slice(0, 6).map(({ local_time: local, location, description, stage }) => [local, location, description, stage])).toEqual([
      ['2025-09-03T15:43:16', 'GB', 'Your express has been delivered', 'delivered'],
      ['2025-09-03T10:32:13', 'GB', 'Unsuccessful Delivery(Due to Customer is not available, shipment has been placed in post office/access point for self-pickup)', 'ready_for_pickup'],
      ['2025-09-03T07:06:00', 'GB', 'Out for delivery', 'out_for_delivery'],
      ['2025-09-01T09:56:25', 'GB', 'Out for delivery', 'out_for_delivery'],
      ['2025-08-31T22:57:26', 'GB', 'Out for delivery', 'out_for_delivery'],
      ['2025-08-31T04:38:02', 'GB', 'Delivery in progress', 'in_transit'],
    ]);
    expect(events.filter(({ description }) => /^Flight (departure|arrival) scan$/.test(description!))).toHaveLength(6);
    expect(events.find(({ description }) => description === 'Depart from the sorting center')).toMatchObject({ local_time: '2025-08-24T23:23:31', stage: 'in_transit' });
    // The facility's place is a dot, which names no place.
    expect(events.at(-2)).toEqual({ local_time: '2025-08-23T20:31:54', description: 'Shipment arrived at facility', stage: 'accepted', stage_source: 'carrier_map' });
    expect(events.at(-1)).toMatchObject({ local_time: '2025-08-06T13:22:17', description: 'Shipment information received', stage: 'registered' });
    expect(events.every((event) => event.local_time && !event.time && !event.provider_code)).toBe(true);
    // The merchant's reference is never read.
    expect(JSON.stringify(result)).not.toMatch(/XM0000000000/);
  });

  it('keeps the delivering network’s number once the line gives one, without naming the network', () => {
    const onward = (channel: string) => parseHuayutong(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), SAMPLE);
    expect(onward('1Z999AA10123456784')).toMatchObject({ delivery_tracking_number: '1Z999AA10123456784' });
    expect(onward('1Z999AA10123456784')).not.toHaveProperty('delivery_carrier');
    for (const channel of [SAMPLE, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads only the entry whose waybill is the number asked', () => {
    // The lookup also finds a parcel by the merchant's reference.
    const elsewhere = changed((reply) => {
      reply.data[0]!.server_hawbcode = 'ZZ0000000000ZZ';
      reply.data[0]!.shipper_hawbcode = SAMPLE;
    });
    expect(() => parseHuayutong(elsewhere, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHuayutong(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseHuayutong(changed((r) => { r.data[0]!.server_hawbcode = 'jcy0806041625dh'; }), SAMPLE)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseHuayutong(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHuayutong(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHuayutong({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHuayutong(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseHuayutong(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2025-09-31 15:43:16'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new HuayutongTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
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
    await expect(new HuayutongTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeHuayutongNumber('jcy0806041625dh')).toBe(SAMPLE);
    for (const number of ['0806041625', 'JCY0806041625', 'JCY080604162DH', 'JCY08060416250DH', 'JC0806041625DH', 'JCY0806041625YQ', 'ZZ0000000000ZZ']) {
      expect(() => normalizeHuayutongNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new HuayutongTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'huayutong', steps: ['direct', 'retry'], recordsSteps: true });
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
    expect(huayutongStage('arrived at the distribution center')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(huayutongStage('快件操作完成')).toBeNull();
  });
});

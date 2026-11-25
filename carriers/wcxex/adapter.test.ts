import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, WCXEX_API, WCXEX_CALLBACK, WcxexTracker, wcxexLookupUrl } from './adapter.js';
import { normalizeWcxexNumber, parseWcxex } from './parser.js';
import { statusMap, wcxexStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples: from an archived capture of ParcelPanel's page for the line, delivered by USPS, and from the
// carrier's own site, delivered by SpeedX, whose number its record holds.
const SAMPLE = 'WX9G030924917026';
const SITE_SAMPLE = 'WX9S080246198026';
const SPEEDX = 'SPXBNA004572609030000487';
type Name = 'delivered-usps' | 'delivered-speedx' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; shipper_hawbcode: unknown; channel_hawbcode: unknown;
  details: { track_occur_date: unknown; track_location: unknown; track_description_en: unknown; track_description: unknown; gmt_offset?: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), WCXEX_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void, name: Name = 'delivered-usps') => { const reply = fixture(name); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const rows = (result: ReturnType<typeof parseWcxex>) =>
  result.events!.map(({ local_time: local, time, location, description, stage }) => [local ?? time, location, description, stage]);

describe('WCXEX numbers', () => {
  it('offers no carrier for the waybill alone and reads the number out of a link to its tracking pages', () => {
    expect(detectCarrierMatch(SAMPLE)).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(parseTrackingInput(`http://www.wcxex.com/track.html?c=${SAMPLE}`)).toMatchObject({ trackingNumber: SAMPLE, carrier: 'wcxex' });
    expect(parseTrackingInput(`http://wc.kjeclub.com/track_query.aspx?track_number=${SAMPLE}`))
      .toMatchObject({ trackingNumber: SAMPLE, carrier: 'wcxex' });
  });
});

describe('WCXEX tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered-usps')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new WcxexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' wx9g 0309-2491-7026 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(wcxexLookupUrl(SAMPLE));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(WCXEX_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: WCXEX_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [SAMPLE] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // Another tenant of the platform answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'wcxex', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel USPS delivered, the line’s coded rows at the +08:00 they state and the rest on wall clocks', () => {
    const result = parseWcxex(fixture('delivered-usps'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered, In/At Mailbox', last_update: null, last_update_local: '2026-04-27T16:01:00', expected_delivery: null,
      destination_country: 'US' });
    // The reply holds no number for USPS and names no carrier.
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('delivery_carrier');
    expect(rows(result)).toEqual([
      // USPS's copies at Los Angeles state the platform's +08:00 without a code, as a label: they keep their wall clocks.
      ['2026-04-27T16:01:00', 'Los Angeles,CA,US', 'Delivered, In/At Mailbox', 'delivered'],
      ['2026-04-26T02:21:00', 'Los Angeles,CA,US', 'Out for Delivery', 'out_for_delivery'],
      ['2026-04-25T23:14:00', 'Los Angeles,CA,US', 'Arrived at Post Office', 'in_transit'],
      ['2026-04-25T17:00:00', 'Los Angeles,CA,US', 'Arrived at USPS Facility', 'in_transit'],
      // USPS's other copies state America/New_York, whichever their place, which is no offset.
      ['2026-04-23T13:53:00', undefined, 'In Transit, Arriving On Time', 'in_transit'],
      ['2026-04-23T11:43:00', 'AVONDALE,AZ', 'Departed USPS Facility', 'in_transit'],
      ['2026-04-23T00:52:00', 'AVONDALE,AZ', 'Shipment picked up', 'in_transit'],
      ['2026-04-22T22:48:00', undefined, 'In Transit to Next Facility', 'in_transit'],
      ['2026-04-22T14:11:00', undefined, 'In Transit to Next Facility', 'in_transit'],
      ['2026-04-22T06:08:00', 'NORTH HOUSTON,TX', 'Departed USPS Regional Facility', 'in_transit'],
      ['2026-04-22T04:42:00', 'NORTH HOUSTON,TX', 'Arrived at USPS Regional Origin Facility', 'in_transit'],
      ['2026-04-22T03:42:00', 'NORTH HOUSTON,TX', 'Shipment picked up', 'in_transit'],
      ['2026-04-20T10:47:00+08:00', 'HOU', 'Shipment arrived at destination facility', 'in_transit'],
      ['2026-04-17T09:24:00+08:00', 'LAX', 'Transition Domestic Supplier', 'in_transit'],
      ['2026-04-17T00:48:00+08:00', 'LAX', 'Flight Arrived', 'in_transit'],
      ['2026-04-16T08:30:00+08:00', 'HKG', 'Flight Departed', 'in_transit'],
      ['2026-04-15T15:34:00+08:00', 'HKG', 'Custom Released - Outbound,Flight Scheduled', 'in_transit'],
      ['2026-04-15T10:47:00+08:00', 'HKG', 'Export declaration', 'in_transit'],
      ['2026-04-14T16:00:52+08:00', 'PVG', 'Shipment leaving', 'in_transit'],
      ['2026-04-13T14:43:24+08:00', 'PVG', 'Process at Location', 'in_transit'],
      ['2026-04-13T14:37:47+08:00', 'PVG', 'Scan packing', 'in_transit'],
      ['2026-04-11T18:57:49+08:00', 'PVG', 'Shipment departed from facility', 'in_transit'],
      ['2026-04-11T18:21:22+08:00', 'PVG', 'Shipment arrived at facility', 'accepted'],
      ['2026-04-04T15:00:27+08:00', undefined, 'Shipment information received', 'registered'],
    ]);
    expect(result.events!.every((event) => !event.provider_code)).toBe(true);
    // A copy stating another signed offset is the partner's own, and gets its instant.
    const pacific = parseWcxex(changed((reply) => { reply.data[0]!.details[0]!.gmt_offset = '-07:00'; }), SAMPLE);
    expect(pacific.events![0]).toMatchObject({ time: '2026-04-27T16:01:00-07:00', description: 'Delivered, In/At Mailbox' });
    // The merchant's reference is never read.
    expect(JSON.stringify(result)).not.toMatch(/0000000000/);
  });

  it('reads a parcel SpeedX delivered, naming SpeedX by its number, and passes over its label record', () => {
    const result = parseWcxex(fixture('delivered-speedx'), SITE_SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered. Position: Front door', last_update: null, last_update_local: '2026-09-12T11:27:25',
      expected_delivery: null, destination_country: 'US', delivery_carrier: 'speedx', delivery_tracking_number: SPEEDX });
    expect(rows(result)).toEqual([
      // SpeedX's copies state their place's offset without a sign, which is no offset.
      ['2026-09-12T11:27:25', 'Christiana, TN', 'Delivered. Position: Front door', 'delivered'],
      ['2026-09-12T06:16:23', 'Christiana, TN', 'Out for Delivery', 'out_for_delivery'],
      ['2026-09-12T04:32:17', 'Nashville, TN', 'Arrival at Destination Facility', 'in_transit'],
      ['2026-09-11T23:19:13', 'Norcross, GA', 'In transit to destination facility', 'in_transit'],
      ['2026-09-11T22:04:15', 'Norcross, GA', 'Processing at Designated Facility', 'in_transit'],
      ['2026-09-11T16:02:54', 'Norcross, GA', 'Arrival at Destination Facility', 'in_transit'],
      ['2026-09-10T23:41:48', 'Linden, NJ', 'In transit to destination facility', 'in_transit'],
      ['2026-09-10T10:47:17', 'Linden, NJ', 'Processing at Transit Facility', 'in_transit'],
      ['2026-09-09T11:38:00+08:00', 'JFK', 'Shipment arrived at destination facility', 'in_transit'],
      ['2026-09-09T08:53:00+08:00', 'JFK', 'Transition Domestic Supplier', 'in_transit'],
      ['2026-09-08T20:38:00+08:00', 'JFK', 'Flight Arrived', 'in_transit'],
      ['2026-09-08T02:41:00+08:00', 'HKG', 'Flight Departed', 'in_transit'],
      ['2026-09-07T15:47:00+08:00', 'HKG', 'Custom Released - Outbound,Flight Scheduled', 'in_transit'],
      ['2026-09-07T10:35:00+08:00', 'HKG', 'Export declaration', 'in_transit'],
      ['2026-09-06T00:00:00+08:00', 'HKG', 'Shipment leaving', 'in_transit'],
      ['2026-09-04T10:58:12+08:00', 'PVG', 'Process at Location', 'in_transit'],
      ['2026-09-03T11:09:56+08:00', 'PVG', 'Scan packing', 'in_transit'],
      ['2026-09-03T10:25:42+08:00', 'PVG', 'Shipment departed from facility', 'in_transit'],
      ['2026-09-02T22:11:31', 'Linden, NJ', 'Shipping Label Created', undefined],
      ['2026-09-02T18:12:03+08:00', 'PVG', 'Shipment arrived at facility', 'accepted'],
      ['2026-08-31T13:06:32+08:00', undefined, 'Shipment information received', 'registered'],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/000000000000|37037/);
  });

  it('keeps the delivering network’s number, naming SpeedX only when its rule claims the number whole', () => {
    const onward = (channel: string) => parseWcxex(changed((reply) => { reply.data[0]!.channel_hawbcode = channel; }), SAMPLE);
    expect(onward(SPEEDX)).toMatchObject({ delivery_carrier: 'speedx', delivery_tracking_number: SPEEDX });
    expect(onward('1Z999AA10123456784')).toMatchObject({ delivery_tracking_number: '1Z999AA10123456784' });
    expect(onward('1Z999AA10123456784')).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', SAMPLE, 'https://example.invalid/x']) {
      expect(onward(channel), channel).not.toHaveProperty('delivery_tracking_number');
      expect(onward(channel), channel).not.toHaveProperty('delivery_carrier');
    }
  });

  it('keeps the wall clock of a row that states no valid offset', () => {
    const result = parseWcxex(changed((reply) => { for (const row of reply.data[0]!.details) row.gmt_offset = ''; }), SAMPLE);
    expect(result.events!.every((event) => event.local_time && !event.time)).toBe(true);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-04-27T16:01:00' });
    expect(parseWcxex(changed((reply) => { reply.data[0]!.details.at(-1)!.gmt_offset = '+8'; }), SAMPLE).events!.at(-1))
      .toMatchObject({ local_time: '2026-04-04T15:00:27' });
  });

  it('reads only the entry whose waybill is the number asked', () => {
    // The lookup also finds a parcel by the merchant's reference or the delivering network's number.
    const elsewhere = changed((reply) => {
      reply.data[0]!.server_hawbcode = SPEEDX;
      reply.data[0]!.channel_hawbcode = SITE_SAMPLE;
    }, 'delivered-speedx');
    expect(() => parseWcxex(elsewhere, SITE_SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWcxex(fixture('delivered-speedx'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseWcxex(changed((r) => { r.data.push(r.data[0]!); }), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parseWcxex(changed((r) => { r.data[0]!.server_hawbcode = SAMPLE.toLowerCase(); }), SAMPLE)).toMatchObject({ current_stage: 'delivered' });
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseWcxex(fixture('not-found'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseWcxex(null, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWcxex({ success: 0, enmessage: 'Try again later' }, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseWcxex(changed((r) => { r.data[0]!.details = []; }), SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseWcxex(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-04-27 25:01:00'; }), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new WcxexTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(SAMPLE, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(raw('delivered-usps'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>验证码</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the tracker', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('delivered-usps')));
    await expect(new WcxexTracker({ fetcher: flaky }).fetch(SAMPLE, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeWcxexNumber('wx9g030924917026')).toBe(SAMPLE);
    for (const number of ['030924917026', 'WX9G03092491702', 'WX9G0309249170260', 'WXG030924917026', 'WX99030924917026', 'WY9G030924917026', SPEEDX, 'ZZ0000000000ZZ']) {
      expect(() => normalizeWcxexNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new WcxexTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'wcxex', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('recognizes by the same lookup', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(response(raw('delivered-usps')));
    await expect(adapter({ fetcher: known, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toMatchObject({ known: true });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER } as never).recognize!(SAMPLE)).resolves.toEqual({ known: false });
  });

  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe('stage' in entry ? entry.stage : undefined);
    }
    expect(wcxexStage('Shipping Label Created')).toBeNull();
    expect(wcxexStage('Out for Delivery')).toEqual({ stage: 'out_for_delivery', source: 'carrier_map' });
    expect(wcxexStage('快件操作完成')).toBeNull();
    expect(statusMapAnswer({ carrier: 'wcxex', description: 'Delivered, In/At Mailbox' })).toEqual({ kind: 'mapped', stage: 'delivered' });
  });
});

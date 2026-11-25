import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { rtb56Json } from '../yypost/rtb56.js';
import { adapter, JTHQ_API, JTHQ_CALLBACK, JthqTracker, jthqLookupUrl } from './adapter.js';
import { normalizeJthqNumber, parseJthq } from './parser.js';
import { jthqStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples from a tracking directory's JTHQ page, and an invented number.
const IN_TRANSIT = 'JTHQ024866600547';
const CANADA = 'JTHQ023937990657';
const US = 'JTHQ022557630284';
const UNKNOWN = 'JTHQ000000000000';
type Name = 'in-transit' | 'canada-post' | 'usps' | 'not-found';
const raw = (name: Name) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
interface Reply { data: { server_hawbcode: unknown; channel_hawbcode: unknown; destination_country: unknown; details: { track_occur_date: unknown }[] }[] }
const fixture = (name: Name) => rtb56Json(raw(name), JTHQ_CALLBACK, 'test') as Reply;
const changed = (change: (reply: Reply) => void) => { const reply = fixture('in-transit'); change(reply); return reply; };
const response = (body: string, init: ResponseInit = {}) => new Response(body,
  { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

describe('JTHQ numbers', () => {
  it('claims JTHQ and twelve digits whole and reads the number out of a link to its tracking page', () => {
    expect(detectCarrierMatch(IN_TRANSIT)).toMatchObject({ carrier: 'jthq', confidence: 'high', candidates: ['jthq'] });
    for (const number of ['JTHQ02486660054', 'JTHQ0248666005470', 'JTHQ02486660054A', 'XJTHQ024866600547', 'JTH024866600547']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('jthq');
    }
    expect(parseTrackingInput(`http://jthq.rtb56.com/track_query.aspx?track_number=${IN_TRANSIT}`))
      .toMatchObject({ trackingNumber: IN_TRANSIT, carrier: 'jthq' });
  });
});

describe('JTHQ tracking lookup', () => {
  it('asks the tenant’s lookup for the whole waybill without naming a referring page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(raw('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new JthqTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' jthq 0248-6660-0547 ', { budgetMs: 5000 });
    expect(result.current_stage).toBe('in_transit');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(jthqLookupUrl(IN_TRANSIT));
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(JTHQ_API);
    expect(asked.protocol).toBe('http:');
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ callbackparam: JTHQ_CALLBACK, method: 'track',
      param: JSON.stringify({ sp: '', nums: [IN_TRANSIT] }) });
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    // The lookup answers null to a request that names a referring page.
    expect(Object.keys((init as RequestInit).headers as Record<string, string>).map((key) => key.toLowerCase())).not.toContain('referer');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'jthq', step: 'direct', outcome: 'ok' }));
  });

  it('reads a parcel bound for Canada with the offsets its scans state and hands it to Canada Post', () => {
    const result = parseJthq(fixture('in-transit'), IN_TRANSIT);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Arrive at destination airport', last_update: '2026-11-24T17:55:00+08:00', expected_delivery: null,
      destination_country: 'CA', delivery_carrier: 'canada-post', delivery_tracking_number: '7321315988367793' });
    expect(result.events!.map(({ time, location, description, stage }) => [time, location, description, stage])).toEqual([
      ['2026-11-24T17:55:00+08:00', 'YYZ', 'Arrive at destination airport', 'in_transit'],
      ['2026-11-24T02:52:00+08:00', 'HKG', 'Leaving the originating airport', 'in_transit'],
      ['2026-11-23T22:07:54+08:00', 'CN', 'In transit', 'in_transit'],
      ['2026-11-22T10:03:11+08:00', 'SHENZHENSHI', 'The Package Is Ready for Shipped Out', 'in_transit'],
      ['2026-11-21T21:38:43+08:00', 'SHENZHENSHI', 'scanned in Warehouse', 'accepted'],
      ['2026-11-20T14:52:06+08:00', undefined, 'Shipment information received', 'registered'],
    ]);
    expect(result.events!.every((event) => !event.local_time && !event.provider_code)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('XM17KKU2A53341C1');
  });

  it('reads Canada Post’s scans on their own offset, whatever code follows a departure', () => {
    const result = parseJthq(fixture('canada-post'), CANADA);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-11-24T10:29:06-05:00',
      delivery_carrier: 'canada-post', delivery_tracking_number: '7321315982281781' });
    expect(result.events).toHaveLength(13);
    expect(result.events!.find(({ description }) => description?.startsWith('Item departed')))
      .toMatchObject({ time: '2026-11-24T03:58:49-05:00', location: 'TORONTO, CA', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events!.find(({ description }) => description === 'Customs clearance in progress')).toMatchObject({ time: '2026-11-22T09:00:00+08:00' });
  });

  it('reads the line to the United States, delivered by USPS, without postcodes', () => {
    const result = parseJthq(fixture('usps'), US);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered, In/At Mailbox',
      last_update: '2026-11-20T16:14:47-05:00', destination_country: 'US', delivery_carrier: 'usps',
      // The routing barcode without the recipient's ZIP code.
      delivery_tracking_number: '9214490424563600907159' });
    expect(result.events).toHaveLength(29);
    expect(result.events![0]).toMatchObject({ location: 'US KY RUSSELL', stage: 'delivered' });
    expect(result.events!.filter(({ description }) => description?.startsWith('Out for Delivery')).map(({ stage, stage_source }) => [stage, stage_source]))
      .toEqual(Array(3).fill(['out_for_delivery', 'carrier_map']));
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-11-03T15:23:09+08:00', stage: 'registered' });
    expect(JSON.stringify(result)).not.toMatch(/41169|25704|11434|XM25PJH107137/);
  });

  it('names a delivering carrier only for a number it would claim on that line', () => {
    const partner = (onward: string, country = 'CA') => parseJthq(changed((reply) => {
      reply.data[0]!.channel_hawbcode = onward;
      reply.data[0]!.destination_country = country;
    }), IN_TRANSIT);
    // A sixteen-digit number without its GS1 digit, or bound elsewhere, is not Canada Post's.
    expect(partner('7321315988367794')).toMatchObject({ delivery_tracking_number: '7321315988367794' });
    expect(partner('7321315988367794')).not.toHaveProperty('delivery_carrier');
    expect(partner('7321315988367793', 'MX')).not.toHaveProperty('delivery_carrier');
    expect(partner('9214490424563600907159', 'US')).toMatchObject({ delivery_carrier: 'usps' });
    for (const onward of ['', IN_TRANSIT, 'https://example.invalid/x']) {
      expect(partner(onward), onward).not.toHaveProperty('delivery_tracking_number');
    }
  });

  it('reads the unknown answer as not found and anything else as a failure, never as not found', async () => {
    expect(() => parseJthq(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseJthq(null, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJthq(changed((r) => { r.data[0]!.server_hawbcode = UNKNOWN; }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJthq(changed((r) => { r.data.push(r.data[0]!); }), IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseJthq({ success: 0, enmessage: 'Try again later' }, IN_TRANSIT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseJthq(changed((r) => { r.data[0]!.details = []; }), IN_TRANSIT)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseJthq(changed((r) => { r.data[0]!.details[0]!.track_occur_date = '2026-11-32 17:55:00'; }), IN_TRANSIT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const lookup = (body: string, init?: ResponseInit) => new JthqTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(body, init)) })
      .fetch(IN_TRANSIT, { budgetMs: 5000 });
    await expect(lookup(raw('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup('null')).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(lookup(raw('in-transit'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><title>验证码</title></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup('', { status: 429, headers: { 'retry-after': '7' } })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('retries only a request that fails to reach the tracker', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('synthetic network'))
      .mockResolvedValueOnce(response(raw('in-transit')));
    await expect(new JthqTracker({ fetcher: flaky }).fetch(IN_TRANSIT, { budgetMs: 5000 })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('accepts the waybill shape only, without a request', async () => {
    expect(normalizeJthqNumber('jthq024866600547')).toBe(IN_TRANSIT);
    for (const number of ['024866600547', 'JTHQ02486660054', 'JTHQ0248666005470', 'JTHX024866600547', 'JTHQ02486660054A']) {
      expect(() => normalizeJthqNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(new JthqTracker({ fetcher }).fetch('LA123456789CN')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(adapter({ fetcher, recorder: NOOP_RECORDER } as never)).toMatchObject({ id: 'jthq', steps: ['direct', 'retry'], recordsSteps: true });
  });

  it('recognizes by the same lookup', async () => {
    const known = vi.fn<typeof fetch>().mockResolvedValue(response(raw('in-transit')));
    await expect(adapter({ fetcher: known, recorder: NOOP_RECORDER } as never).recognize!(IN_TRANSIT)).resolves.toMatchObject({ known: true });
    const unknown = vi.fn<typeof fetch>().mockResolvedValue(response(raw('not-found')));
    await expect(adapter({ fetcher: unknown, recorder: NOOP_RECORDER } as never).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });

  it('maps every wording it lists, reading a departure’s code and a delivery window as an ellipsis', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
    }
    expect(statusMap.stage(null, 'item departed 0042')).toBe('in_transit');
    expect(statusMap.stage(null, 'out for delivery, expected delivery between 9:00am and 11:00am')).toBe('out_for_delivery');
    expect(statusMap.stage('IR', 'Shipment information received')).toBe('registered');
    expect(jthqStage('仓库作业')).toBeNull();
  });
});

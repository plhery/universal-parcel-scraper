import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, PargoTracker, pargoLookupUrl } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { normalizePargoNumber, parsePargo } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample, a shop's warehouse-to-door order, and a synthetic code of its shape the tracker does not know.
const NUMBER = numbers.records[0]!.number, UNKNOWN = 'PAR0000000000';

type Json = Record<string, unknown>;
type Scan = Json & { code: string; date: string; seq: number };
type Reply = { meta: Json; data: Json & { orderData: Json; events: Scan[]; currentStatus: Json | null; addresses: Json[] }; success: boolean; statusCode: number };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The sample's reply with its order, its scans and its other fields changed. */
const edit = (change: Json = {}, scans?: (events: Scan[]) => Scan[], order: Json = {}): Reply => {
  const reply = fixture('delivered');
  return { ...reply, data: { ...reply.data, ...change, orderData: { ...reply.data.orderData, ...order },
    events: scans ? scans(reply.data.events) : reply.data.events } };
};
const json = (body: unknown, init: ResponseInit = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

// A synthetic order sent from a warehouse to a pickup point, with its point and a recipient's address it must not show.
const POINT = { type: 'pickupPoint', businessName: 'Example Pharmacy', address1: 'Shop 1 Example Centre', address2: '1 Example Road',
  suburb: 'Exampleville', city: 'Example City', postalCode: '0001', country: 'ZA', province: 'Example Province',
  openingHours: 'Mon-Fri: 9am-6pm', photoUrl: 'https://files.example.com/point.jpg', shortUrlCode: 'Abcd', reference: 'pup0001' };
const HOME = { type: 'residential', address1: '1 Recipient Street', suburb: 'Recipientville', city: 'Example City', postalCode: '0002' };
const scan = (code: string, date: string, seq: number, title: string): Scan => ({ level: 'major', date, code, title, description: '', seq });
const toPoint = (...extra: Scan[]) => edit({
  currentStatus: { name: 'Completed', code: extra.at(-1)?.code ?? '1.20.4.400', title: extra.at(-1)?.title ?? 'Parcel arrived at pickup point',
    updatedAt: extra.at(-1)?.date ?? '2026-07-16T09:00:00+00:00' },
  addresses: [POINT, HOME],
}, () => [
  scan('1.20.4.200', '2026-07-14T06:36:06+00:00', 0, 'Parcel is being prepared'),
  scan('1.20.4.301', '2026-07-14T14:00:00+00:00', 1, 'Parcel collected by courier'),
  scan('1.20.4.302', '2026-07-14T20:00:00+00:00', 2, 'Parcel at courier hub'),
  scan('1.20.4.303', '2026-07-16T06:00:00+00:00', 3, 'Parcel out for delivery'),
  scan('1.20.4.400', '2026-07-16T09:00:00+00:00', 4, 'Parcel arrived at pickup point'),
  ...extra,
], { orderType: 'W2P' });

describe('Pargo numbers', () => {
  it('takes letters and digits, in capitals', () => {
    expect(normalizePargoNumber(` ${NUMBER.toLowerCase().replace(/(\d{4})/g, '$1 ')} `)).toBe(NUMBER);
    // The tracker also files orders under a shop's waybill.
    expect(normalizePargoNumber('un1234545')).toBe('UN1234545');
    for (const other of ['', 'PAR1', `${NUMBER}/x`, `${NUMBER}?a=1`, 'PAR%2F0000000', `PAR${'1'.repeat(40)}`]) {
      expect(() => normalizePargoNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Pargo tracking adapter', () => {
  it('asks the tracker as its page does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PargoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(NUMBER.toLowerCase(), { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://track.pargo.co.za/events/orders/${NUMBER}`);
    expect(pargoLookupUrl(NUMBER)).toBe(url);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/json', Referer: 'https://track.pargo.co.za/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pargo', step: 'direct', outcome: 'ok' }));
    expect(carrier(fetcher)).toMatchObject({ id: 'pargo', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s refusal of a code it holds no order for as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found'), { status: 422 }));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps refusals, block pages, error pages and redirects apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: UNKNOWN }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
      new Response(body, { status, headers: { 'Content-Type': 'text/html', ...headers } });
    const refusal = fixture('not-found') as unknown as { errors: Json[] };
    expect(await answer(() => json({ errors: [{ title: 'Too Many Requests' }] }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<TITLE>ERROR: The request could not be satisfied</TITLE> Request blocked. Generated by cloudfront', 403)))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<script>window.gokuProps={}</script><script src="https://example.awswaf.com/challenge.js"></script>', 202)))
      .toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({}, { status: 202 }, { 'x-amzn-waf-action': 'challenge' }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({ message: 'Forbidden' }, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>Not Found</h1>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html><body>Track your parcel</body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response(null, { status: 308, headers: { Location: 'https://pargo.co.za/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ message: 'Internal Server Error' }, { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    // A refusal for another reference, or of another kind, says nothing about this code.
    const other = { ...refusal, errors: [{ ...refusal.errors[0], detail: 'Cannot find an order with reference: PAR1111111111' }] };
    expect(await answer(() => json(other, { status: 422 }))).toMatchObject({ kind: 'indeterminate' });
    const unknownError = { ...refusal, errors: [{ title: 'validation_error', detail: 'The reference is invalid', code: 0, path: 'search' }] };
    expect(await answer(() => json(unknownError, { status: 422 }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({ meta: {}, success: false, statusCode: 422 }, { status: 422 }))).toMatchObject({ kind: 'schema' });
  });
});

describe('Pargo replies', () => {
  it('reads the sample: its scans as instants, newest first, and the shop that sent it', () => {
    const result = parsePargo(fixture('delivered'), NUMBER);
    const events = result.events ?? [];
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Parcel delivered',
      last_update: '2026-07-17T20:35:56Z', delivered_at: '2026-07-17T20:35:56Z', expected_delivery: null, sender_name: 'Toner and Ink',
    });
    expect(result.summary_only).toBeUndefined();
    expect(result.pickup_point).toBeUndefined();
    expect(events.map((event) => [event.time, event.provider_code, event.stage])).toEqual([
      ['2026-07-17T20:35:56Z', '1.40.4.400', 'delivered'],
      ['2026-07-17T05:10:35Z', '1.40.4.303', 'out_for_delivery'],
      ['2026-07-16T22:00:50Z', '1.40.4.302', 'in_transit'],
      ['2026-07-14T20:17:50Z', '1.40.4.301', 'accepted'],
      ['2026-07-14T15:56:11Z', '1.40.4.302', 'in_transit'],
      ['2026-07-14T06:40:50Z', '1.40.4.310', 'registered'],
      ['2026-07-14T06:36:06Z', '1.40.4.200', 'registered'],
      ['2026-07-14T06:36:04Z', '1.40.4.100', 'registered'],
    ]);
    expect(events[0]).toEqual({ time: '2026-07-17T20:35:56Z', description: 'Parcel delivered', provider_code: '1.40.4.400',
      stage: 'delivered', stage_source: 'carrier_map' });
    // The shop's support contacts, its order reference, the courier and the recipient's address stay behind.
    expect(JSON.stringify(result)).not.toMatch(/example\.com|0000000000|WO25305|DPD|residential|W2D/);
  });

  it('names the pickup point an order waits at and was collected from, never the recipient’s address', () => {
    const waiting = parsePargo(toPoint(), NUMBER);
    const point = 'Example Pharmacy\nShop 1 Example Centre\n1 Example Road\nExampleville\nExample City 0001';
    expect(waiting).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup', pickup_point: point,
      last_status_text: 'Parcel arrived at pickup point' });
    expect(waiting.events![0]).toMatchObject({ stage: 'ready_for_pickup', location: 'Example Pharmacy, Example City' });
    // The way to the point is no delivery round.
    expect(waiting.events![1]).toMatchObject({ provider_code: '1.20.4.303', stage: 'in_transit' });
    expect(waiting.events!.slice(1).every((event) => event.location === undefined)).toBe(true);

    const collected = parsePargo(toPoint(scan('1.20.4.500', '2026-07-18T10:00:00+00:00', 5, 'Parcel collected')), NUMBER);
    expect(collected).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2026-07-18T10:00:00Z', pickup_point: point });
    expect(collected.events!.slice(0, 2).map((event) => event.location)).toEqual(['Example Pharmacy, Example City', 'Example Pharmacy, Example City']);
    for (const result of [waiting, collected]) expect(JSON.stringify(result)).not.toMatch(/Recipient|0002|Mon-Fri|files\.example|pup0001/);

    // Not collected, it goes back: no point is named.
    const back = parsePargo(toPoint(scan('1.20.4.10010', '2026-07-25T10:00:00+00:00', 5, 'Parcel not collected')), NUMBER);
    expect(back).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(back.pickup_point).toBeUndefined();
    // Two points, or a point on an order to the door, name none.
    const twoPoints = toPoint();
    twoPoints.data.addresses = [POINT, { ...POINT, businessName: 'Other Point' }];
    expect(parsePargo(twoPoints, NUMBER).pickup_point).toBeUndefined();
    expect(parsePargo(edit({ addresses: [POINT] }), NUMBER).pickup_point).toBeUndefined();
  });

  it('keeps the tracker’s order for scans of one instant, newest first', () => {
    const result = parsePargo(edit({}, (scans) => [...scans.slice(0, 2), { ...scans[2]!, date: scans[1]!.date }]), NUMBER);
    expect(result.events!.map((event) => event.provider_code)).toEqual(['1.40.4.310', '1.40.4.200', '1.40.4.100']);
  });

  it('reads an order without scans as a summary, and an unknown status without a stage', () => {
    const summary = parsePargo(edit({ currentStatus: { name: 'Pending', code: '1.40.4.100', title: 'Parcel Notification',
      updatedAt: '2026-07-14T06:36:04+00:00' } }, () => []), NUMBER);
    expect(summary).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'Parcel Notification', provider_code: '1.40.4.100', summary_only: true, last_update: '2026-07-14T06:36:04Z',
      expected_delivery: null, sender_name: 'Toner and Ink', events: [] });
    const unknown = parsePargo(edit({ currentStatus: { name: 'Odd', code: '1.40.4.999', title: 'Synthetic status' } }), NUMBER);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic status' });
    expect(unknown.current_stage).toBeUndefined();
    // A return's owner is where it goes, not who sent it.
    expect(parsePargo(edit({}, undefined, { orderType: 'P2W_RETURN' }), NUMBER).sender_name).toBeUndefined();
  });

  it('refuses another order’s reply', () => {
    expect(() => parsePargo(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const changed = (change: Json) => (scans: Scan[]) => [{ ...scans[0]!, ...change }, ...scans.slice(1)];
    const reply = fixture('delivered');
    for (const payload of [null, {}, { ...reply, success: false }, { ...reply, data: { ...reply.data, orderData: null } },
      edit({}, undefined, { trackingCode: null }), edit({}, () => ({}) as Scan[]), edit({}, changed({ date: '2026-07-14 06:36:04' })),
      edit({}, changed({ date: '2026-02-30T06:36:04+00:00' })), edit({}, changed({ code: 'W2D_PENDING' })), edit({}, changed({ title: null })),
      edit({}, changed({ seq: 'first' })), edit({}, (scans) => [...scans, 'scan' as unknown as Scan]), edit({ currentStatus: 'Completed' }),
      edit({ currentStatus: null }, () => []), edit({}, (scans) => Array.from({ length: 301 }, () => scans[0]!))]) {
      expect(() => parsePargo(payload, NUMBER), JSON.stringify(payload)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Pargo statuses', () => {
  it('maps each code and wording the tracker and Pargo’s documentation give', () => {
    expect(STATUS_MAPS.pargo).toBe(statusMap);
    for (const entry of statuses.entries as readonly { code?: string; wording?: string; stage: string }[]) {
      const code = entry.code ?? null;
      const wording = normalizeStatusWording(entry.wording ?? '');
      expect(statusMap.stage(code, wording), code ?? wording).toBe(entry.stage);
    }
  });

  it('reads a wording without a code only where every flow gives it one stage', () => {
    expect(statusMap.stage(null, 'parcel delivered')).toBe('delivered');
    expect(statusMap.stage(null, 'parcel arrived at pickup point')).toBe('ready_for_pickup');
    // On the way to a point, to the door, or back to the shop.
    expect(statusMap.stage(null, 'parcel out for delivery')).toBeUndefined();
    expect(statusMap.stage('1.40.4.303', 'parcel out for delivery')).toBe('out_for_delivery');
    expect(statusMap.stage('1.20.4.303', 'parcel out for delivery')).toBe('in_transit');
    expect(statusMap.stage('1.99.4.100', 'parcel delivered')).toBe('delivered');
    expect(statusMap.stage('1.99.4.100', 'synthetic status')).toBeUndefined();
  });
});

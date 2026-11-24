import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, OBIBOX_PAGE, obiboxLookupUrl, ObiboxTracker } from './adapter.js';
import { normalizeObiboxNumber, parseObibox } from './parser.js';
import { obiboxStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

type Milestone = Record<string, unknown> & { shipment: Record<string, unknown>; tracking?: Record<string, unknown> };
type Reply = Record<string, unknown> & { tracking_statuses: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const milestone = (reply: Reply, key: string) => reply[key] as Milestone;
const edited = (change: (reply: Reply) => void, name = 'delivered') => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// Every copy of the shipment states its current status.
const currently = (reply: Reply, status: string) => {
  for (const value of Object.values(reply)) if ((value as Milestone)?.shipment) (value as Milestone).shipment.status = status;
};

// The public sample, a parcel collected from the shop and delivered hand to hand.
const ITEM = milestone(fixture('delivered'), 'shipment_ready').shipment.tracking_number as string;
// A synthetic number of Obibox's shape, which the tracker does not know.
const UNKNOWN = 'XPSYN1234567890Q1';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const once = (response: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(response);
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Obibox tracking adapter', () => {
  it('asks the tracker for the whole number, as the tracking page does, through the supplied transport', async () => {
    const fetcher = once(json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ObiboxTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${ITEM.toLowerCase()} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://api.obibox.io/shipment_tracking/public/shipment_tracking?tracking_number=${ITEM}&_force=1`);
    expect(url).toBe(obiboxLookupUrl(ITEM));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'Cache-Control': 'no-cache', 'X-Force-Refresh': '1', 'X-Requested-With': 'XMLHttpRequest',
      Referer: OBIBOX_PAGE, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'obibox', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s scans as instants with their offset, its delivery and its shop', () => {
    const result = parseObibox(fixture('delivered'), ITEM);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Package delivered to recipient', last_update: '2026-05-13T22:42:08Z', expected_delivery: null,
      sender_name: 'Darwynn', events: expect.any(Array),
    });
    expect(result.events).toEqual([
      { time: '2026-05-13T22:42:08Z', description: 'Package delivered to recipient', provider_code: 'delivered_recipient_here',
        stage: 'delivered', stage_source: 'carrier_map' },
      { time: '2026-05-13T22:38:34Z', description: 'Package is out for delivery', provider_code: 'on_delivery',
        stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { time: '2026-05-13T12:48:34Z', description: 'Package has been picked up', provider_code: 'pickup_confirmed',
        stage: 'accepted', stage_source: 'carrier_map' },
      { time: '2026-05-13T12:24:38Z', description: 'Shipment ready for delivery with status: engaged', provider_code: 'shipment_ready_engaged',
        stage: 'registered', stage_source: 'carrier_map' },
      { time: '2026-05-11T21:06:49Z', description: 'Package Ready for Shipping', provider_code: 'shipment_ready_pending',
        stage: 'registered', stage_source: 'carrier_map' },
    ]);
  });

  it('never reads the recipient, the addresses, the instructions, the order number or a position', () => {
    const result = parseObibox(edited((reply) => {
      for (const key of ['shipment_ready', 'pickup_confirmed', 'on_delivery', 'delivered_recipient_here']) {
        Object.assign(milestone(reply, key).shipment, { recipients_name: 'RECIPIENT NAME', to_address: 'RECIPIENT STREET', from_address: 'SHOP STREET',
          to_gps: '45.1111111,-73.1111111', from_gps: '45.2222222,-73.2222222', delivery_instructions: 'DOOR CODE 1234',
          customer_order_number: '#98765', delivery_note: 'DRIVER NOTE' });
      }
      milestone(reply, 'on_delivery').tracking = { current_courier_location: '45.3333333,-73.3333333', eta: ['5 mins', '1.4 km'] };
      reply.tracking_statuses[0]!.location = 'RECIPIENT STREET';
    }), ITEM);
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT|SHOP STREET|45\.|DOOR CODE|98765|DRIVER NOTE|5 mins|Example|00000/);
    for (const field of ['receiver_name', 'receiver_address', 'signed_by', 'pickup_point']) expect(result).not.toHaveProperty(field);
    expect(result.events!.every((event) => event.location === undefined && event.point === undefined)).toBe(true);
  });

  it('gives a collected parcel the delivery window of its collection, and a parcel still ready its delivery day', () => {
    const collected = edited((reply) => {
      reply.tracking_statuses = reply.tracking_statuses.slice(0, 3);
      delete reply.on_delivery;
      delete reply.delivered_recipient_here;
      currently(reply, 'pickup_confirmed');
    });
    expect(parseObibox(collected, ITEM)).toMatchObject({ status: 'in_transit', current_stage: 'accepted',
      expected_delivery_from: '2026-05-13T15:30:00-04:00', expected_delivery: '2026-05-13T19:30:00-04:00' });
    // Out for delivery, the driver's time away is a field the adapter does not read; the collection's window stays.
    const out = edited((reply) => {
      reply.tracking_statuses = reply.tracking_statuses.slice(0, 4);
      delete reply.delivered_recipient_here;
      currently(reply, 'on_delivery');
      milestone(reply, 'on_delivery').tracking = { current_courier_location: '0,0', eta: ['5 mins', '1.4 km'] };
    });
    expect(parseObibox(out, ITEM)).toMatchObject({ status: 'out_for_delivery', expected_delivery_from: '2026-05-13T15:30:00-04:00',
      expected_delivery: '2026-05-13T19:30:00-04:00', unread_estimates: ['on_delivery.tracking.eta'] });
    // Before the collection the page shows the shipment's delivery date, as a day.
    const ready = edited((reply) => {
      reply.tracking_statuses = reply.tracking_statuses.slice(0, 2);
      for (const key of ['pickup_confirmed', 'on_delivery', 'delivered_recipient_here']) delete reply[key];
      currently(reply, 'shipment_ready_engaged');
    });
    expect(parseObibox(ready, ITEM)).toMatchObject({ status: 'pending', current_stage: 'registered', expected_delivery: '2026-05-13' });
    expect(parseObibox(ready, ITEM)).not.toHaveProperty('expected_delivery_from');
    // A reply that hides the collection's steps gives a ready parcel its window.
    const hidden = edited((reply) => {
      milestone(reply, 'shipment_ready').tracking = { eta_start: '2026-05-14T09:00:00-04:00', eta_end: '2026-05-14T13:00:00-04:00' };
      reply.hide_pickup_statuses = true;
    }, 'delivered');
    for (const key of ['pickup_confirmed', 'on_delivery', 'delivered_recipient_here']) delete hidden[key];
    hidden.tracking_statuses = hidden.tracking_statuses.slice(0, 2);
    currently(hidden, 'shipment_ready_engaged');
    expect(parseObibox(hidden, ITEM)).toMatchObject({ expected_delivery_from: '2026-05-14T09:00:00-04:00', expected_delivery: '2026-05-14T13:00:00-04:00' });
    // No estimate without a delivery date, or with one that is no date.
    for (const date of [null, '2026-02-30 09:45:00', 'tomorrow']) {
      const undated = edited((reply) => { reply.tracking_statuses = reply.tracking_statuses.slice(0, 2); currently(reply, 'shipment_ready_engaged');
        for (const value of Object.values(reply)) if ((value as Milestone)?.shipment) (value as Milestone).shipment.delivery_date = date; });
      for (const key of ['pickup_confirmed', 'on_delivery', 'delivered_recipient_here']) delete undated[key];
      expect(parseObibox(undated, ITEM).expected_delivery, String(date)).toBeNull();
    }
  });

  it('reads the tracker\'s 404 for a number it does not know as not found, and binds the answer to the number asked', async () => {
    expect(() => parseObibox(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(once(json(fixture('not-found'), 404))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // The reply for another number, as a cache could give it, is no answer.
    expect(() => parseObibox(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(once(json(fixture('delivered')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    // One copy of the shipment for another number spoils the reply.
    expect(() => parseObibox(edited((reply) => { milestone(reply, 'on_delivery').shipment.tracking_number = UNKNOWN; }), ITEM))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseObibox(edited((reply) => { delete milestone(reply, 'on_delivery').shipment.tracking_number; }), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // Another message or code under 404 is no answer about the number.
    expect(() => parseObibox({ message: 'No Parcel Found', code: 12002 }, ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('stands on the current status without scans, and lists the shipment without one the map knows', () => {
    expect(parseObibox(edited((reply) => { reply.tracking_statuses = []; }), ITEM)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: 'delivered_recipient_here',
      last_status_text: 'Delivered Recipient Here', last_update: null, expected_delivery: null, sender_name: 'Darwynn',
      summary_only: true, events: [] });
    expect(() => parseObibox(edited((reply) => { delete (reply as Record<string, unknown>).tracking_statuses; currently(reply, 'synthetic_state'); }), ITEM))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    // The page's view of a shipment whose collection it hides: its details alone.
    const details = { ...milestone(fixture('delivered'), 'shipment_ready').shipment, status: '' };
    expect(() => parseObibox({ hide_pickup_statuses: true, shipment_info: details, tracking_statuses: [] }, ITEM))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseObibox({ hide_pickup_statuses: true, shipment_info: { ...details, tracking_number: UNKNOWN } }, ITEM))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('stages an unknown code by its description, and lets a newer unstaged scan stand over a collection but not a delivery', () => {
    const noted = (status: string, description: string) => parseObibox(edited((reply) => {
      reply.tracking_statuses.push({ status, timestamp: '2026-05-14T12:00:00+00:00', description, location: null });
    }), ITEM);
    expect(noted('synthetic_returned', 'Package returned to sender').events![0]).toMatchObject({ provider_code: 'synthetic_returned',
      stage: 'returned', stage_source: expect.stringMatching(/^wording:/) });
    // A code without a description reads as the page words it.
    expect(noted('synthetic_note', '').events![0]).toEqual({ time: '2026-05-14T12:00:00Z', description: 'Synthetic Note',
      provider_code: 'synthetic_note' });
    expect(noted('synthetic_note', '')).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic Note' });
    const collected = edited((reply) => {
      reply.tracking_statuses = reply.tracking_statuses.slice(0, 3);
      reply.tracking_statuses.push({ status: 'synthetic_note', timestamp: '2026-05-13T13:00:00+00:00', description: 'Synthetic note' });
    });
    expect(parseObibox(collected, ITEM)).toMatchObject({ status: 'in_transit', current_stage: 'accepted', last_status_text: 'Synthetic note' });
  });

  it('orders scans newest first whatever the reply\'s order, and refuses a changed reply', () => {
    const reversed = parseObibox(edited((reply) => { reply.tracking_statuses.reverse(); }), ITEM).events!;
    expect(reversed.map((event) => event.provider_code)).toEqual(parseObibox(fixture('delivered'), ITEM).events!.map((event) => event.provider_code));
    // Two scans of one instant: the later in the oldest-first reply is the newer.
    const tied = parseObibox(edited((reply) => { reply.tracking_statuses[4]!.timestamp = reply.tracking_statuses[3]!.timestamp; }), ITEM).events!;
    expect(tied.slice(0, 2).map((event) => event.provider_code)).toEqual(['delivered_recipient_here', 'on_delivery']);
    expect(parseObibox(edited((reply) => { reply.tracking_statuses[4]!.timestamp = '2026-05-13T18:42:08-04:00'; }), ITEM).events![0])
      .toMatchObject({ time: '2026-05-13T18:42:08-04:00' });
    const scan = (change: (row: Record<string, unknown>) => void) => edited((reply) => change(reply.tracking_statuses[4]!));
    for (const reply of [
      null, [], 'No Parcel Found', {}, { tracking_statuses: [] }, { message: 'Not Found' },
      edited((value) => { value.tracking_statuses = {} as never; }),
      edited((value) => { value.tracking_statuses = Array.from({ length: 301 }, () => value.tracking_statuses[0]!); }),
      edited((value) => { value.shipment_info = 'details'; }),
      edited((value) => { milestone(value, 'on_delivery').shipment.tracking_number = 12345; }),
      scan((row) => { row.timestamp = '2026-05-13 22:42:08'; }),
      scan((row) => { row.timestamp = '2026-05-13T22:42:08'; }),
      scan((row) => { row.timestamp = null; }),
      scan((row) => { row.timestamp = 1778712128; }),
      scan((row) => { row.timestamp = '1970-01-01T00:00:00+00:00'; }),
      scan((row) => { row.status = 'Delivered!'; }),
      scan((row) => { row.status = null; }),
      scan((row) => { row.description = { text: 'Delivered' }; }),
      edited((value) => { value.tracking_statuses[0] = 'Delivered' as never; }),
    ]) {
      expect(() => parseObibox(reply, ITEM), JSON.stringify(reply)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps browser checks, refusals, moved routes, outages and rate limits apart from a missing parcel, and retries a network failure once', async () => {
    const reading = (response: Response) => carrier(once(response)).track({ number: ITEM });
    await expect(reading(page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page(BLOCKED, 404))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page('<html><title>403 Forbidden</title></html>', 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(json({ message: 'Unauthenticated.' }, 401))).rejects.toMatchObject({ kind: 'challenge' });
    // The gateway's own 404, a page under 404 and a gone route are a moved tracker, not a missing parcel.
    await expect(reading(json({ message: 'Not Found' }, 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(page('<html><title>404 Not Found</title></html>', 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(json('', 410))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(page('', 301, { Location: 'https://obibox.co/' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(json({ message: 'Too Many Requests' }, 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(reading(page('<html><title>Service Unavailable</title></html>', 503))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(reading(json({ message: 'Server Error' }, 500))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(reading(page('<html><title>Obibox Tracking</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json('{"shipment_ready":'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json(fixture('not-found')))).rejects.toMatchObject({ kind: 'not_found' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes 8 to 40 letters, digits and underscores, in capitals, and refuses anything else before a request', async () => {
    expect(normalizeObiboxNumber(' xpsyn1234567890q1 ')).toBe(UNKNOWN);
    expect(normalizeObiboxNumber('XPSYN1234567890_1')).toBe('XPSYN1234567890_1');
    for (const bad of ['XP12345', 'X'.repeat(41), 'XPSYN1234567890/1', '', 'X'.repeat(65)]) {
      expect(() => normalizeObiboxNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'XP12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps the sample and the synthetic number on Obibox\'s own rule', () => {
    for (const number of [ITEM, UNKNOWN]) expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'obibox', confidence: 'high' });
  });

  it('maps every recorded code to its stage', () => {
    expect(STATUS_MAPS.obibox).toBe(statusMap);
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(obiboxStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.stage('delivery_attempt_12', '')).toBe('failed_attempt');
    expect(statusMap.codeKey!('delivery_attempt_3')).toBe('delivery_attempt');
    // The map reads codes: a wording that comes without one gets no stage from it.
    expect(statusMap.stage(null, normalizeStatusWording('Package delivered to recipient'))).toBeUndefined();
    expect(statusMap.stage('delivery_attempt', '')).toBeUndefined();
  });
});

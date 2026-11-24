import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, delivroLookupUrl, delivroPageUrl, DelivroTracker } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };
import { normalizeDelivroNumber, parseDelivro } from './parser.js';
import { delivroOrder, delivroStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample: an order picked up, put on hold for missing information, released and delivered.
const ITEM = corpus.records[0]!.number;
// A synthetic order id of the same shape, which the tracker does not know.
const UNKNOWN = 'DEL9640731';

type Reply = Record<string, unknown> & { history: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const edited = (change: (reply: Reply) => void, name = 'delivered') => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
// The sample before its delivery: picked up, on hold, released.
const underway = (change: (reply: Reply) => void = () => undefined) => edited((reply) => {
  reply.history.shift();
  reply.status = '2';
  reply.statusDeliveredDate = null;
  change(reply);
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}, type = 'application/json; charset=utf-8') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type, ...headers } });
const problem = (body: unknown, status = 404) => json(body, status, {}, 'application/problem+json; charset=utf-8');
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const once = (response: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(response);
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Délivro tracking adapter', () => {
  it('asks the tracker for the whole order id, in English, as the tracking page does, through the supplied transport', async () => {
    const fetcher = once(json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const typed = ` ${ITEM.slice(0, 3).toLowerCase()} ${ITEM.slice(3)} `;
    await expect(new DelivroTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(typed, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://delivro.dsapp.io/api/v1/orders/tracking/${ITEM}`);
    expect(url).toBe(delivroLookupUrl(ITEM));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en', 'Content-Type': 'application/json',
      Referer: delivroPageUrl(ITEM), 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(['Accept', 'Accept-Language', 'Content-Type', 'Referer', 'User-Agent']);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'delivro', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s checkpoints at the offsets the reply states, its hold and its delivery', () => {
    const result = parseDelivro(fixture('delivered'), ITEM);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Order delivered', last_update: '2026-06-30T17:44:19-04:00', expected_delivery: null,
      delivered_at: '2026-06-30T17:44:19-04:00',
      events: [
        { time: '2026-06-30T17:44:19-04:00', description: 'Order delivered', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-06-30T10:25:20-04:00', description: 'Order released', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-06-30T09:48:47-04:00', description: 'Order put on hold', stage: 'exception', stage_source: 'carrier_map' },
        { time: '2026-06-29T14:49:00-04:00', description: 'Order picked up', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-06-27T10:34:53-04:00', description: 'Order information received', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('never reads the towns, the map positions, the signature, the checkpoints\' notes or the support line', () => {
    const result = parseDelivro(edited((reply) => {
      reply.canShowOrderMapTracking = true;
      reply.canShowOrderMapTrackingPositions = true;
      reply.deliveryLocation = { latitude: 46.123456, longitude: -71.123456 };
      reply.driverLocation = { latitude: 46.654321, longitude: -71.654321 };
      reply.displayDeliverySignature = true;
      reply.history[0]!.additionalCheckpointInfo = 'RECEIVED BY RECIPIENT NAME';
      reply.history[0]!.additionalInfo = 'Left at RECIPIENT STREET';
    }), ITEM);
    expect(JSON.stringify(result)).not.toMatch(/TOWN|RECIPIENT|Missing information|418|46\.|71\.|dispatchstorage|signature|#e8412c/i);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('receiver_address');
    expect(result).not.toHaveProperty('signed_by');
    expect(result.events!.every((event) => event.location === undefined && event.point === undefined)).toBe(true);
  });

  it('reads the tracker\'s 404 for an order id it does not know as not found, and binds a reply to the order id asked', async () => {
    await expect(carrier(once(problem(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // The reply for another order, as a cache could give it, is no answer.
    expect(() => parseDelivro(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(once(json(fixture('delivered')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    // Another problem document says nothing about the order.
    await expect(carrier(once(problem({ ...fixture('not-found'), detail: 'Tenant not found' }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(once(problem({ title: 'Bad Request', status: 400 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    // A 404 without the problem document is a missing route: a moved tracker, not a missing order.
    await expect(carrier(once(new Response(null, { status: 404 }))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(once(page('<html><title>404</title></html>', 404))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(once(page('', 410))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
  });

  it('gives an order not yet delivered the drop-off window, or its ETA, and a cancelled order none', () => {
    expect(parseDelivro(underway(), ITEM)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Order released',
      expected_delivery: '2026-06-30T23:00:00-04:00', expected_delivery_from: '2026-06-29T08:00:00-04:00' });
    expect(parseDelivro(underway(), ITEM)).not.toHaveProperty('delivered_at');
    expect(parseDelivro(underway((reply) => { reply.eta = '2026-06-30T14:05:00-04:00'; }), ITEM))
      .toMatchObject({ expected_delivery: '2026-06-30T14:05:00-04:00' });
    expect(parseDelivro(underway((reply) => { reply.eta = '2026-06-30T14:05:00-04:00'; }), ITEM)).not.toHaveProperty('expected_delivery_from');
    // A window of one instant is that instant.
    const instant = parseDelivro(underway((reply) => { reply.dropoffFromTime = reply.dropoffToTime; }), ITEM);
    expect(instant).toMatchObject({ expected_delivery: '2026-06-30T23:00:00-04:00' });
    expect(instant).not.toHaveProperty('expected_delivery_from');
    // An estimate in another shape is named as unread rather than guessed.
    expect(parseDelivro(underway((reply) => { reply.eta = '14:05'; }), ITEM)).toMatchObject({ expected_delivery: null, unread_estimates: ['eta'] });
    expect(parseDelivro(underway((reply) => { reply.dropoffToTime = '2026-06-30 23:00'; }), ITEM))
      .toMatchObject({ expected_delivery: null, unread_estimates: ['dropoffFromTime', 'dropoffToTime'] });
    expect(parseDelivro(underway((reply) => { reply.dropoffFromTime = '2026-07-01T08:00:00-04:00'; }), ITEM))
      .toMatchObject({ expected_delivery: null, unread_estimates: ['dropoffFromTime', 'dropoffToTime'] });
    expect(parseDelivro(underway((reply) => { reply.dropoffFromTime = null; reply.dropoffToTime = null; }), ITEM))
      .toMatchObject({ expected_delivery: null });
    const cancelled = parseDelivro(underway((reply) => {
      reply.status = '91';
      reply.history.unshift({ ...reply.history[0], timestamp: '2026-06-30T11:00:00-04:00', description: 'Order cancelled', status: '91' });
    }), ITEM);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'wording:language',
      last_status_text: 'Order cancelled', expected_delivery: null });
    expect(cancelled).not.toHaveProperty('expected_delivery_from');
  });

  it('stages checkpoints by their wording in English or French, an interruption as a problem, and the order by its code when no checkpoint leads', () => {
    const french = edited((reply) => {
      const words = ['Commande livrée', 'Commande débloquée', 'Commande mise en attente', 'Commande récupérée', 'Informations de la commande reçues'];
      reply.history.forEach((row, index) => { row.description = words[index]; });
    });
    expect(parseDelivro(french, ITEM).events!.map((event) => [event.stage, event.stage_source]))
      .toEqual([['delivered', 'carrier_map'], ['in_transit', 'carrier_map'], ['exception', 'carrier_map'], ['accepted', 'carrier_map'], ['registered', 'carrier_map']]);
    // A wording the map does not know: flagged as an interruption, a problem; else the shared rules, else no stage.
    expect(delivroStage('Synthetic hold', true)).toEqual({ stage: 'exception', source: 'carrier_map' });
    expect(delivroStage('Synthetic note', false)).toBeNull();
    expect(delivroStage('Order picked up', true)).toEqual({ stage: 'accepted', source: 'carrier_map' });
    // A newer checkpoint without a stage leaves the delivery to the order's code.
    const noted = parseDelivro(edited((reply) => {
      reply.history.unshift({ ...reply.history[0], timestamp: '2026-06-30T18:00:00-04:00', description: 'Synthetic note' });
    }), ITEM);
    expect(noted).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Synthetic note' });
    expect(noted.events![0]).toEqual({ time: '2026-06-30T18:00:00-04:00', description: 'Synthetic note' });
    // Without checkpoints the order stands on its code, when the page names it.
    expect(parseDelivro(edited((reply) => { reply.history = []; reply.status = 3; reply.statusDeliveredDate = null; }), ITEM)).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map', provider_code: '3',
      last_status_text: 'En Route', last_update: null, expected_delivery: '2026-06-30T23:00:00-04:00',
      expected_delivery_from: '2026-06-29T08:00:00-04:00', summary_only: true, events: [] });
    expect(() => parseDelivro(edited((reply) => { reply.history = []; reply.status = '7'; }), ITEM))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(parseDelivro(edited((reply) => {
      reply.history = [{ ...reply.history[0], description: 'Synthetic note' }];
      reply.status = '7';
    }), ITEM)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
  });

  it('keeps each instant\'s stated offset to the second, turns an oldest-first history round and refuses a changed reply', () => {
    const time = (value: unknown) => edited((reply) => { reply.history[0]!.timestamp = value; });
    expect(parseDelivro(time('2026-06-30T21:44:19.8396561Z'), ITEM).events![0]).toMatchObject({ time: '2026-06-30T21:44:19Z' });
    expect(parseDelivro(time('2026-01-30T17:44:19-05:00'), ITEM).events!.at(-1)).toMatchObject({ time: '2026-01-30T17:44:19-05:00' });
    for (const bad of ['2026-06-30T17:44:19', '2026-06-30 17:44:19-04:00', '2026-06-30T24:00:00-04:00', '2026-02-30T10:00:00-05:00',
      '1999-06-30T17:44:19-04:00', '', null, 1782855859]) {
      expect(() => parseDelivro(time(bad), ITEM), String(bad)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    const reversed = parseDelivro(edited((reply) => { reply.history.reverse(); }), ITEM).events!;
    expect(reversed.map((event) => event.description)).toEqual(parseDelivro(fixture('delivered'), ITEM).events!.map((event) => event.description));
    for (const reply of [
      null, [], { status: '4' }, { orderId: 5 },
      edited((value) => { value.history = {} as never; }),
      edited((value) => { value.history[0]!.description = ''; }),
      edited((value) => { value.history[0]!.description = { text: 'Order delivered' }; }),
      edited((value) => { value.history[0]!.interruption = 'yes'; }),
      edited((value) => { value.history[0] = 'Order delivered' as never; }),
      edited((value) => { value.status = 'Delivered'; }),
      edited((value) => { value.statusDeliveredDate = '30/06/2026'; }),
      edited((value) => { value.history = Array.from({ length: 301 }, () => value.history[0]!); }),
    ]) {
      expect(() => parseDelivro(reply, ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps browser checks, refusals, moved routes, maintenance, rate limits and server errors apart from a missing order, and retries a network failure once', async () => {
    const reading = (response: Response) => carrier(once(response)).track({ number: ITEM });
    await expect(reading(page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page(BLOCKED, 503))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page('<html><body><h2>The request is blocked.</h2></body></html>', 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(problem({ title: 'Forbidden', status: 403 }, 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page('<html><title>Service Unavailable</title></html>', 503))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(reading(page('', 302, { Location: 'https://delivro.dsapp.io/Account/Login' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(json('', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(reading(problem({ title: 'An error occurred', status: 500 }, 500))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(reading(page('<html><title>Dispatch Science</title><app-root></app-root></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json('{"orderId":'))).rejects.toMatchObject({ kind: 'schema' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes 6 to 40 letters and digits with a digit, in capitals, and refuses anything else before a request', async () => {
    expect(normalizeDelivroNumber(ITEM.toLowerCase())).toBe(ITEM);
    expect(normalizeDelivroNumber('syn12345')).toBe('SYN12345');
    for (const bad of ['DEL12', 'DELIVRO', 'A'.repeat(40) + '1', 'DEL964/0731', '', 'X'.repeat(65)]) {
      expect(() => normalizeDelivroNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'DEL12' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording and order code to its stage', () => {
    expect(STATUS_MAPS.delivro).toBe(statusMap);
    for (const entry of statuses.entries) {
      const code = ('code' in entry ? entry.code : undefined) ?? null;
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)), entry.wording).toBe(entry.stage);
      if (code) expect(delivroOrder(code), code).toEqual({ stage: entry.stage, label: entry.wording });
      else expect(delivroStage(entry.wording, false), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(delivroOrder('7')).toBeUndefined();
  });
});

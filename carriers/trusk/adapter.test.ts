import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierInputs } from '../../core/catalog/inputs.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, TRUSK_LOOKUP } from './adapter.js';
import { normalizeTruskNumber, parseTrusk, truskOrderId } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples from numbers.json: order ids as their links write them, and an invented one.
const DELIVERED_SAMPLE = 'f4JZFWKhwf';
const ARCHIVED_SAMPLE = 'TVb_j5l55P';
const OTHER = 'Zz9Zz9Zz9Z';
const link = (order: string) => `https://track.trusk.com/${order}`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const ARCHIVED = fixture('delivered-archived');
const AWAITING = fixture('awaiting-slot');
const NOT_FOUND = fixture('not-found');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const track = (fetcher: typeof fetch, order = OTHER) => carrier(fetcher).track({ number: order.toUpperCase(), trackingUrl: link(order) }, { budgetMs: 2000 });
// A synthetic order in the reply's shape: booked, loaded and on its way.
const order = (fields: Record<string, unknown> = {}) => ({
  deliveryInfos: { brand: 'Synthetic Shop', packages: 2, weight: 31.5, floorConfig: 'curbside', installation: 'none', returnOrRemoval: 'none' },
  contactInfos: { name: '********ith', phone: '********12', address: '9 ********' },
  isPickupCompletedSuccessful: true, isDropoffCompletedSuccessful: false, orderNumber: 'SYNTHETIC-77',
  slot: { start: '2026-11-25T07:00:00.000Z', end: '2026-11-25T11:00:00.000Z' }, eta: '08h00 - 12h00', isFailed: false,
  timeline: [
    { title: 'order_created', state: 'success', isNextStep: false, subtitles: ['2026-11-20T09:00:00.000Z'] },
    { title: 'appointment_validated', state: 'success', isNextStep: false, subtitles: ['2026-11-21T10:30:00.000Z'] },
    { title: 'pickup_completed', state: 'success', isNextStep: false, subtitles: ['2026-11-25T06:10:00.000Z'] },
    { title: 'dropoff', state: 'inprogress', isNextStep: true, subtitles: ['2026-11-25T06:40:00.000Z'] },
  ],
  truskerInfos: { name: 'Driver' }, deliveryId: 'SYNTHET1C0', isRemovalOrder: false, ...fields,
});

describe('Trusk order links', () => {
  it('reads the order id as the link writes it, with or without a language, bound to the tracking number', () => {
    expect(truskOrderId(link(DELIVERED_SAMPLE), DELIVERED_SAMPLE)).toBe(DELIVERED_SAMPLE);
    expect(truskOrderId(`https://track.trusk.com/fr/${ARCHIVED_SAMPLE}?utm_source=sms`, ARCHIVED_SAMPLE.toUpperCase())).toBe(ARCHIVED_SAMPLE);
    expect(normalizeCarrierInputs('trusk', DELIVERED_SAMPLE.toUpperCase(), `https://track.trusk.com/fr/${DELIVERED_SAMPLE}/`, ''))
      .toEqual({ trackingUrl: link(DELIVERED_SAMPLE), postcode: null, phoneDigits: null });
    expect(normalizeCarrierInputs('trusk', DELIVERED_SAMPLE.toUpperCase(), '', '')).toEqual({ trackingUrl: null, postcode: null, phoneDigits: null });
    expect(parseTrackingInput(link(DELIVERED_SAMPLE))).toMatchObject({ trackingNumber: DELIVERED_SAMPLE, carrier: 'trusk', trackingUrl: link(DELIVERED_SAMPLE) });
    for (const other of [link(ARCHIVED_SAMPLE), `http://track.trusk.com/${DELIVERED_SAMPLE}`, `https://trusk.com/${DELIVERED_SAMPLE}`,
      `${link(DELIVERED_SAMPLE)}?x=1`, `${link(DELIVERED_SAMPLE)}#top`, 'not a link', `https://track.trusk.com/api/order/${DELIVERED_SAMPLE}`]) {
      expect(() => truskOrderId(other, DELIVERED_SAMPLE), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('takes order ids of 6 to 32 letters, digits, hyphens and underscores', () => {
    expect(normalizeTruskNumber(` ${ARCHIVED_SAMPLE} `)).toBe(ARCHIVED_SAMPLE.toUpperCase());
    for (const other of ['', 'ABCDE', 'A'.repeat(33), 'ABC.DEF/GH', 'ABCDEF;GHIJ']) {
      expect(() => normalizeTruskNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Trusk tracking adapter', () => {
  it('reads the order the link names from the lookup its page reads', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    await expect(track(fetcher, DELIVERED_SAMPLE)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(`${TRUSK_LOOKUP}${DELIVERED_SAMPLE}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect(carrier(fetcher)).toMatchObject({ id: 'trusk', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('asks for the order link, which alone keeps the id’s letter case', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(DELIVERED));
    expect(() => carrier(fetcher).track({ number: DELIVERED_SAMPLE.toUpperCase() })).toThrow(expect.objectContaining({ kind: 'input_required' }));
    // A pasted link gives the tracking number and keeps itself for the lookup.
    const pasted = parseTrackingInput(`https://track.trusk.com/fr/${DELIVERED_SAMPLE}`);
    await expect(createTracker({ fetcher, env: {}, providers: [] }).track({ number: pasted.trackingNumber, carrier: 'trusk', trackingUrl: pasted.trackingUrl }))
      .resolves.toMatchObject({ carrier: 'trusk', source: 'trusk', result: { current_stage: 'delivered' } });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${TRUSK_LOOKUP}${DELIVERED_SAMPLE}`);
  });

  it('reads the lookup’s not-found answers as not found', async () => {
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json(NOT_FOUND, { status: 404 })))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(track(vi.fn<typeof fetch>().mockResolvedValue(json('{"error":"Not Found"}', { status: 404 })))).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, other refusals, redirects and changed replies apart from a missing order', async () => {
    const answer = async (response: () => Response) => track(vi.fn<typeof fetch>().mockImplementation(async () => response())).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json('{"message":"Unauthorized"}', { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => json('{"message":"Invalid order id"}', { status: 400 }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => json('{"error":"order_not_recoverable","detail":"x"}', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{"error":"Internal"}', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<h1>404</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 307, headers: { Location: 'https://track.trusk.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => json('{"error":"order_not_recoverable"}', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    // The site answers its order page's address with the page itself.
    expect(await answer(() => html('<!DOCTYPE html><html><body><div id="__next"></div></body></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json('not json'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json(NOT_FOUND))).toMatchObject({ kind: 'schema' });
  });
});

describe('Trusk replies', () => {
  it('reads a delivered order from an archived reply, each step at its instant, newest first', () => {
    expect(parseTrusk(JSON.parse(ARCHIVED))).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Livraison terminée',
      last_update: '2026-02-18T13:20:06.138Z', expected_delivery: null, sender_name: 'Ikea', weight_kg: 22,
      events: [
        { time: '2026-02-18T13:20:06.138Z', description: 'Livraison terminée', provider_code: 'dropoff_completed', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-02-18T09:55:52.011Z', description: 'Chargement effectué', provider_code: 'pickup_completed', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-02-13T11:50:54.861Z', description: 'Commande validée', provider_code: 'order_created', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads the delivered sample, whose earlier steps keep no time', () => {
    expect(parseTrusk(JSON.parse(DELIVERED))).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Livraison terminée',
      last_update: '2026-09-03T07:32:48.228Z', expected_delivery: null, sender_name: 'Ikea', weight_kg: 47.06,
      events: [{ time: '2026-09-03T07:32:48.228Z', description: 'Livraison terminée', provider_code: 'dropoff_completed', stage: 'delivered', stage_source: 'carrier_map' }],
    });
  });

  it('gives no estimate while the recipient still has a slot to choose', () => {
    expect(parseTrusk(JSON.parse(AWAITING))).toMatchObject({
      status: 'pending', current_stage: 'registered', last_status_text: 'Choix du créneau de livraison', expected_delivery: null,
      sender_name: 'Emma Web', weight_kg: 45.82,
    });
  });

  it('reads a delivery under way with its booked slot', () => {
    expect(parseTrusk(order())).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Livraison', last_update: '2026-11-25T06:40:00Z',
      expected_delivery_from: '2026-11-25T07:00:00.000Z', expected_delivery: '2026-11-25T11:00:00.000Z', sender_name: 'Synthetic Shop', weight_kg: 31.5,
    });
  });

  it('reads failed and cancelled steps as problems', () => {
    const failed = order({ timeline: [...order().timeline.slice(0, 3),
      { title: 'dropoff_failed_label', state: 'error', isNextStep: false, subtitles: ['2026-11-25T09:00:00.000Z'] }] });
    expect(parseTrusk(failed)).toMatchObject({ current_stage: 'failed_attempt', last_status_text: 'Livraison' });
    const cancelled = order({ timeline: [...order().timeline.slice(0, 2),
      { title: 'pickup_completed', state: 'aborted', isNextStep: false, subtitles: ['2026-11-24T09:00:00.000Z'] }] });
    expect(parseTrusk(cancelled)).toMatchObject({ current_stage: 'exception' });
  });

  it('stands on the furthest step done when no step keeps a time', () => {
    const steps = [{ title: 'order_created', state: 'success', isNextStep: false, subtitles: [] },
      { title: 'pickup_completed', state: 'success', isNextStep: false, subtitles: [] },
      { title: 'dropoff', state: 'waiting', isNextStep: true, subtitles: ['waiting'] }];
    expect(parseTrusk(order({ timeline: steps }))).toMatchObject({
      status: 'in_transit', current_stage: 'accepted', last_status_text: 'Chargement effectué', last_update: null, summary_only: true, events: [],
    });
    expect(() => parseTrusk(order({ timeline: [] }))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // A later step done without a time leads over an earlier one with a time.
    const mixed = [{ title: 'appointment_validated', state: 'success', isNextStep: false, subtitles: ['2026-11-21T10:30:00.000Z'] }, steps[1], steps[2]];
    expect(parseTrusk(order({ timeline: mixed }))).toMatchObject({ current_stage: 'accepted', last_status_text: 'Chargement effectué', events: [{ provider_code: 'appointment_validated' }] });
  });

  it('never reads the recipient, the retailer’s order number, the driver or Trusk’s own ids', () => {
    const answer = JSON.stringify([parseTrusk(order()), parseTrusk(JSON.parse(DELIVERED))]);
    for (const hidden of ['********', 'SYNTHETIC-77', 'Driver', 'SYNTHET1C0', 'XXXXXXXXXX', '0000000000', '08h00']) expect(answer).not.toContain(hidden);
  });

  it('refuses a changed reply', () => {
    const step = (fields: Record<string, unknown>) => order({ timeline: [{ title: 'order_created', state: 'success', subtitles: [], ...fields }] });
    for (const changed of [null, [], 'x', {}, order({ timeline: {} }), order({ deliveryInfos: 'x' }), order({ slot: 'x' }), order({ deliveryInfos: { brand: 7 } }),
      step({ title: 7 }), step({ title: 'Commande validée' }), step({ state: 'done' }), step({ subtitles: 'x' }), step({ subtitles: ['20/11/2026'] }),
      step({ subtitles: ['2026-11-20T09:00:00'] }), step({ subtitles: [null] }), order({ timeline: [null] }),
      order({ timeline: Array.from({ length: 41 }, () => order().timeline[0]) })]) {
      expect(() => parseTrusk(changed), JSON.stringify(changed)?.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Trusk statuses', () => {
  it('maps every step by its key', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'trusk', providerCode: entry.code, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage(null, 'livraison')).toBeUndefined();
    expect(statusMap.stage('unknown_step', 'livraison')).toBeUndefined();
  });
});

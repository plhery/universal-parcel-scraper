import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, PARCEL_ONE_PAGE, parcelOneLookupUrl, ParcelOneTracker } from './adapter.js';
import { normalizeParcelOneNumber, parseParcelOne } from './parser.js';
import { parcelOneProgress, parcelOneStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample: a parcel PARCEL.ONE handed to Liechtenstein Post at its hub, delivered to a mailbox.
const ITEM = '4002102255056';
// Liechtenstein Post's number for it, eighteen digits of Swiss Post's network.
const PARTNER = '994717434200216281';
// A synthetic number of the same shape, which the tracker does not know.
const UNKNOWN = '4002109876543';
const EASYTRACK = `https://service.post.ch/EasyTrack/submitParcelData.do?formattedParcelCodes=${PARTNER}&lang=en`;

type Reply = Record<string, unknown> & { carrier: Record<string, unknown> | null; events: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const edited = (change: (reply: Reply) => void, name = 'delivered') => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...headers } });
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const once = (response: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(response);
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('PARCEL.ONE tracking adapter', () => {
  it('asks the tracker for the whole number with an empty postcode, in English, through the supplied transport', async () => {
    const fetcher = once(json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ParcelOneTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 4002 1022 55056 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://parcel.one/wp-json/parcelone/v1/track?trackno=${ITEM}&zip=&lang=en`);
    expect(url).toBe(parcelOneLookupUrl(ITEM));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', Referer: PARCEL_ONE_PAGE, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'parcel-one', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s scans as wall clocks, its delivery and its hand-over to Swiss Post\'s network', () => {
    const result = parseParcelOne(fixture('delivered'), ITEM);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment has been delivered to the mailbox of the recipient.',
      last_update: null, last_update_local: '2026-07-17T08:57:00', expected_delivery: null,
      delivery_carrier: 'swiss-post', delivery_tracking_number: PARTNER,
    });
    expect(result.events).toHaveLength(10);
    expect(result.events![0]).toEqual({ local_time: '2026-07-17T08:57:00', location: '805070',
      description: 'The shipment has been delivered to the mailbox of the recipient.', stage: 'delivered', stage_source: 'carrier_map' });
    // The hand-over's link to the delivery carrier's tracker leaves its number in the text.
    expect(result.events![5]).toEqual({ local_time: '2026-07-14T14:18:00', location: 'DE Pohlheim', stage: 'in_transit', stage_source: 'carrier_map',
      description: `The shipment has left the P1 HUB and can be tracked further in the tracking system of the respective carrier using the shipment number ${PARTNER}.` });
    expect(result.events!.at(-1)).toEqual({ local_time: '2026-07-06T10:03:00', location: 'DE Legden',
      description: 'The shipment has been prepared for transportation by the sender.', stage: 'registered', stage_source: 'carrier_map' });
    // Two scans of one minute keep the tracker's order, newest first.
    expect(result.events!.slice(6, 8).map((event) => event.stage)).toEqual(['in_transit', 'in_transit']);
    expect(result.events!.slice(6, 8).map((event) => event.description)).toEqual([
      `The shipping label with trackingno ${PARTNER} has been created.`, 'The shipment arrived the P1 HUB and is now being handled.']);
    // Every scan has a mapped stage and no instant: the reply names no zone.
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/<a |href|logo|clink/i);
  });

  it('never reads the recipient or the postcode, which the tracker gives with the right postcode', () => {
    const result = parseParcelOne(edited((reply) => {
      reply.zipCode = '00000';
      reply.recipient = { name1: 'RECIPIENT NAME', name2: 'RECIPIENT COMPANY', name3: null, street: 'RECIPIENT STREET', houseNumber: '1',
        zip: '00000', city: 'RECIPIENT TOWN', country: 'XX', phone: '+00 000 000', email: 'recipient@example.com' };
    }), ITEM);
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT|00000|example\.com|\+00/);
    expect(result).not.toHaveProperty('receiver_name');
    expect(result).not.toHaveProperty('receiver_address');
  });

  it('names the delivery carrier only from a link of one catalog carrier whose shape the number has', () => {
    const partner = (change: (block: Record<string, unknown>) => void, asked = ITEM) =>
      parseParcelOne(edited((reply) => { change(reply.carrier!); reply.trackingNumber = asked; }), asked);
    const handoff = (result: Record<string, unknown>) => ({ carrier: result.delivery_carrier, number: result.delivery_tracking_number });
    // A tracking link comes before the logo's.
    expect(handoff(partner((block) => { block.trackingUrl = EASYTRACK; block.logoHtml = null; })))
      .toEqual({ carrier: 'swiss-post', number: PARTNER });
    // A link no catalog carrier owns, none at all, or PARCEL.ONE's own names no carrier; the number stays.
    expect(handoff(partner((block) => { block.logoHtml = '<a href=https://carrier.example/track><img src=https://carrier.example/logo.png></a>'; })))
      .toEqual({ carrier: undefined, number: PARTNER });
    expect(handoff(partner((block) => { block.logoHtml = null; }))).toEqual({ carrier: undefined, number: PARTNER });
    expect(handoff(partner((block) => { block.trackingUrl = `https://parcel.one/tracking?trackno=${PARTNER}`; })))
      .toEqual({ carrier: undefined, number: PARTNER });
    // Swiss Post's link beside a number of no shape of Swiss Post's, which the link does not open.
    expect(handoff(partner((block) => { block.trackingNumber = 'SYN12345'; }))).toEqual({ carrier: undefined, number: 'SYN12345' });
    // Asked by the delivery carrier's number, which the tracker also finds, the parcel has no second reference.
    expect(handoff(partner(() => undefined, PARTNER))).toEqual({ carrier: 'swiss-post', number: undefined });
    // A block without a number, or none, names nothing.
    expect(handoff(partner((block) => { block.trackingNumber = ''; }))).toEqual({ carrier: undefined, number: undefined });
    expect(handoff(parseParcelOne(edited((reply) => { reply.carrier = null; }), ITEM))).toEqual({ carrier: undefined, number: undefined });
  });

  it('reads the tracker\'s message for a number it does not know as not found, and binds the answer to the number asked', async () => {
    expect(() => parseParcelOne(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(once(json(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // The reply for another number, as a cache could give it, is no answer.
    expect(() => parseParcelOne(fixture('not-found'), ITEM)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseParcelOne(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // Another message, or a parcel's details beside the message, says nothing about the number.
    expect(() => parseParcelOne(edited((reply) => { reply.error = 'Service temporarily unavailable'; }, 'not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseParcelOne(edited((reply) => { reply.error = null; }, 'not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseParcelOne(edited((reply) => { reply.carrier = { trackingNumber: PARTNER }; }, 'not-found'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('stages a parcel by its newest staged scan, and by the progress code when no scan has a stage or there is none', () => {
    const unstaged = edited((reply) => { reply.events = reply.events.slice(0, 2).map((event) => ({ ...event, status: 'Synthetic note' })); });
    expect(parseParcelOne(unstaged, ITEM)).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Synthetic note', events: [{ description: 'Synthetic note' }, { description: 'Synthetic note' }] });
    expect(parseParcelOne(unstaged, ITEM).events!.every((event) => event.stage === undefined)).toBe(true);
    // A newer scan the map does not know leaves the delivery under it.
    const noted = edited((reply) => { reply.events.unshift({ ...reply.events[0], date: '2026-07-18 09:00', status: 'Synthetic note' }); });
    expect(parseParcelOne(noted, ITEM)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Synthetic note' });
    expect(parseParcelOne(edited((reply) => { reply.events = []; reply.trackingProgress = 'TrackProg40'; }), ITEM)).toEqual({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map', provider_code: 'TrackProg40',
      last_status_text: 'Out for Delivery', last_update: null, expected_delivery: null,
      delivery_carrier: 'swiss-post', delivery_tracking_number: PARTNER, summary_only: true, events: [] });
    expect(() => parseParcelOne(edited((reply) => { reply.events = []; reply.trackingProgress = 'TrackProg010'; }), ITEM))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', deliveryCarrier: 'swiss-post', deliveryTrackingNumber: PARTNER }));
    expect(parseParcelOne(edited((reply) => { reply.events = reply.events.slice(0, 1).map((event) => ({ ...event, status: 'Synthetic note' }));
      reply.trackingProgress = null; }), ITEM)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic note' });
  });

  it('turns an oldest-first history round and refuses a changed reply', () => {
    const reversed = parseParcelOne(edited((reply) => { reply.events.reverse(); }), ITEM).events!;
    expect(reversed[0]).toMatchObject({ local_time: '2026-07-17T08:57:00' });
    expect(reversed.at(-1)).toMatchObject({ local_time: '2026-07-06T10:03:00' });
    const date = (value: unknown) => edited((reply) => { reply.events[0]!.date = value; });
    for (const bad of ['17.07.2026 08:57', '2026-02-30 08:57', '2026-07-17 24:00', '2026-07-17T08:57:00+02:00', '', null, 1784270220]) {
      expect(() => parseParcelOne(date(bad), ITEM), String(bad)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseParcelOne(date('2026-07-17 08:57:31'), ITEM).events![0]).toMatchObject({ local_time: '2026-07-17T08:57:31' });
    for (const reply of [
      null, [], { found: 'yes', trackingNumber: ITEM }, { found: true }, { code: 'rest_no_route', message: 'No route', data: { status: 404 } },
      edited((value) => { value.events = {} as never; }),
      edited((value) => { value.events[0]!.status = ''; }),
      edited((value) => { value.events[0]!.status = { text: 'Delivered' }; }),
      edited((value) => { value.events[0] = 'Delivered' as never; }),
      edited((value) => { value.carrier = 'Swiss Post' as never; }),
      edited((value) => { value.events = Array.from({ length: 301 }, () => value.events[0]!); }),
    ]) {
      expect(() => parseParcelOne(reply, ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps browser checks, refusals, moved routes, maintenance and rate limits apart from a missing parcel, and retries a network failure once', async () => {
    const reading = (response: Response) => carrier(once(response)).track({ number: ITEM });
    await expect(reading(page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page(BLOCKED, 503))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page('', 403, { 'cf-mitigated': 'challenge' }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(json({ code: 'rest_forbidden' }, 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page('<html><title>Wartungsmodus</title></html>', 503))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(reading(json({ code: 'rest_no_route', message: 'No route', data: { status: 404 } }, 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(page('', 301, { Location: 'https://parcel.one/' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(json('', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(reading(page('<html><title>PARCEL.ONE</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json('{"found":'))).rejects.toMatchObject({ kind: 'schema' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes 6 to 40 letters and digits, in capitals, and refuses anything else before a request', async () => {
    expect(normalizeParcelOneNumber(' 4002 1022 55056 ')).toBe(ITEM);
    expect(normalizeParcelOneNumber('syn12345')).toBe('SYN12345');
    for (const bad of ['40021', 'A'.repeat(41), '4002-1022/55056?', '', 'X'.repeat(65)]) {
      expect(() => normalizeParcelOneNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '40021' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording and progress code to its stage', () => {
    expect(STATUS_MAPS['parcel-one']).toBe(statusMap);
    for (const entry of statuses.entries) {
      const wording = entry.wording.replace('<number>', PARTNER);
      const code = ('code' in entry ? entry.code : undefined) ?? null;
      expect(statusMap.stage(code, normalizeStatusWording(wording)), wording).toBe(entry.stage);
      if (code) expect(parcelOneProgress(code), code).toEqual({ stage: entry.stage, label: entry.wording });
      else expect(parcelOneStage(wording), wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(parcelOneProgress('TrackProg010')).toBeUndefined();
    expect(statusMap.stage(null, normalizeStatusWording('The shipping label with trackingno has been created.'))).toBeUndefined();
  });
});

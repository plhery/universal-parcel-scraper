import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';
import { carrierInfo } from '../../core/catalog/index.js';
import { SchemaError, InvalidInputError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { fillPartialAnswer } from '../../core/result/partial.js';
import {
  normalizeInpostTrackingNumber,
  parseInpostTrackingResponse,
  InpostTracker,
  adapter,
} from './adapter.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { classifyInpostStatus, statusMap } from './status.js';
import { parseInpostPickup } from './pickup.js';

// All identifiers and timestamps below are synthetic. Status codes and the
// response shape follow the keyless inposteasy.com hub as documented by the
// prior-art client, live-confirmed on IT/PT/GB consignments 2026-08-31.
const TRACKING_NUMBER = '649999999999999999999980';
const DELIVERED = JSON.parse(
  readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const CAPABILITIES = (JSON.parse(
  readFileSync(new URL('./carrier.json', import.meta.url), 'utf8'),
) as { capabilities: string[] }).capabilities;

function parcel(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(DELIVERED), ...overrides };
}

function response(value: unknown, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFoundProblem(trackingNumber = TRACKING_NUMBER) {
  return {
    type: '/errors/external/not-found', title: 'NOT_FOUND', status: 404,
    instance: `/api/tracking/${trackingNumber}`,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('InPost tracking normalization', () => {
  it('accepts the detected InPost families case-insensitively and rejects the rest', () => {
    expect(normalizeInpostTrackingNumber('649999999999999999999980')).toBe(TRACKING_NUMBER);
    expect(normalizeInpostTrackingNumber('jjd0002233564270287')).toBe('JJD0002233564270287');
    expect(normalizeInpostTrackingNumber('8ydr098765432')).toBe('8YDR098765432');
    expect(normalizeInpostTrackingNumber('00abc0000001a001')).toBe('00ABC0000001A001');
    for (const raw of ['12345', 'Z8328162951', '0ABC00000001A001', '']) {
      expect(() => normalizeInpostTrackingNumber(raw)).toThrow(InvalidInputError);
    }
  });
});

describe('InPost tracking links', () => {
  it('opens InPost UK for Yodel layouts and the Polish page for the rest', () => {
    const link = carrierInfo('inpost').trackingUrl!;
    expect(link(TRACKING_NUMBER)).toBe(`https://inpost.pl/sledzenie-przesylek?number=${TRACKING_NUMBER}`);
    for (const number of ['JJD0002233564270287', 'JD0002123456789012', '8YDR098765432', '00ABC0000001A001']) {
      expect(link(number)).toBe(`https://inpost.co.uk/tracking/result?parcel_code=${number}`);
    }
    expect(link('00abc 0000001a001')).toBe('https://inpost.co.uk/tracking/result?parcel_code=00ABC0000001A001');
  });
});

describe('InPost response parsing', () => {
  it('returns delivered history newest-first with explicit offsets preserved', () => {
    const result = parseInpostTrackingResponse(parcel(), TRACKING_NUMBER);
    expect(result).toMatchObject({
      status: 'delivered',
      current_stage: 'delivered',
      last_status_text: 'Delivered',
      last_update: '2026-05-04T10:00:00+02:00',
      expected_delivery: null,
    });
    expect(result.events?.map((event) => [event.description, event.stage, event.time])).toEqual([
      ['Delivered', 'delivered', '2026-05-04T10:00:00+02:00'],
      ['Ready for pickup', 'ready_for_pickup', '2026-05-03T09:00:00+02:00'],
      // The logistics centre's receipt, with nothing before it that moved the parcel, is the acceptance.
      ['Moving', 'accepted', '2026-05-02T12:00:00+02:00'],
      ['Registered', 'registered', '2026-05-01T08:00:00+02:00'],
    ]);
    expect(result.events?.map((event) => event.location)).toEqual(['Exampletown (DE)', 'Exampletown (DE)', 'EXAMPLE HUB (PL)', '']);
    // Each scan keeps its own code, which the parcel app's review reads.
    expect(result.events?.every((event) => /^[A-Z]{3}\.\d{4}$/.test(event.provider_code ?? ''))).toBe(true);
    expect(result).toMatchObject({ delivered_at: '2026-05-04T10:00:00+02:00', destination_country: 'DE' });
  });

  it('keeps scans of one instant in the carrier\'s order', () => {
    const trackingDetails = (DELIVERED.trackingDetails as Record<string, unknown>[])
      .map((scan) => (scan.status === 'LMD.1004' ? { ...scan, datetime: '2026-05-02T12:00:00+02:00' } : scan));
    expect(parseInpostTrackingResponse(parcel({ trackingDetails }), TRACKING_NUMBER).events?.map((event) => event.description))
      .toEqual(['Delivered', 'Ready for pickup', 'Moving', 'Registered']);
  });

  it('keeps no delivery time for a returned parcel and leaves out a place without a town', () => {
    const result = parseInpostTrackingResponse(parcel({
      status: 'RTS.1002',
      statusTitle: 'Returned to sender',
      destination: { countryCode: 'unknown' },
      trackingDetails: [
        { status: 'FMD.1001', statusTitle: 'Posted at a locker', datetime: '2026-05-01T08:00:00+02:00', place: 'Exampleville (PL)' },
        { status: 'LMD.1001', statusTitle: 'Out for delivery', datetime: '2026-05-02T08:00:00+02:00', place: 'Exampleville (PL)' },
        { status: 'LMD.9006', statusTitle: 'Refused', datetime: '2026-05-02T12:00:00+02:00', place: 'Exampleville (PL)' },
        { status: 'RTS.1002', statusTitle: 'Returned to sender', datetime: '2026-05-06T10:00:00+02:00', place: 'null (PL)' },
      ],
    }), TRACKING_NUMBER);
    expect(result.events?.map((event) => [event.stage, event.location])).toEqual([
      ['returned', ''],
      ['failed_attempt', 'Exampleville (PL)'],
      ['out_for_delivery', 'Exampleville (PL)'],
      ['accepted', 'Exampleville (PL)'],
    ]);
    expect(result).toMatchObject({ status: 'exception', current_stage: 'returned' });
    expect(result).not.toHaveProperty('delivered_at');
    expect(result).not.toHaveProperty('destination_country');
  });

  it('maps every documented public-hub status code', () => {
    const cases: Array<[string, string, string]> = [
      ['CRE.1001', 'pending', 'registered'],
      ['FMD.1001', 'in_transit', 'accepted'],
      ['FMD.1002', 'in_transit', 'accepted'],
      ['LMD.1001', 'out_for_delivery', 'out_for_delivery'],
      ['LMD.9004', 'exception', 'failed_attempt'],
      ['LMD.9006', 'exception', 'failed_attempt'],
      ['LMD.9015', 'exception', 'failed_attempt'],
      ['MMD.1003', 'in_transit', 'in_transit'],
      ['LMD.1002', 'in_transit', 'in_transit'],
      ['LMD.1005', 'out_for_delivery', 'ready_for_pickup'],
      ['LMD.9002', 'exception', 'exception'],
      ['LMD.9014', 'exception', 'returned'],
      ['LMD.9012', 'out_for_delivery', 'ready_for_pickup'],
      ['LMD.3009', 'in_transit', 'in_transit'],
      ['LMD.3005', 'in_transit', 'in_transit'],
      ['EOL.1003', 'delivered', 'delivered'],
      ['EOL.9001', 'exception', 'failed_attempt'],
      ['RTS.1002', 'exception', 'returned'],
    ];
    for (const [code, status, stage] of cases) {
      expect(classifyInpostStatus(code)).toEqual({ status, stage });
      const result = parseInpostTrackingResponse(parcel({ status: code, trackingDetails: [] }), TRACKING_NUMBER);
      expect(result).toMatchObject({ status, current_stage: stage });
    }
  });

  it('reads a courier collection booked under FMD.1001 as registered, until the courier collects the parcel', () => {
    const booked = { status: 'FMD.1001', statusTitle: 'We will collect it soon', datetime: '2026-05-01T14:00:00+02:00', place: 'Exampletown (IT)' };
    const waiting = parseInpostTrackingResponse(parcel({ status: 'FMD.1001', statusTitle: 'We will collect it soon', trackingDetails: [
      { status: 'CRE.1001', statusTitle: 'Parcel created', datetime: '2026-05-01T08:00:00+02:00' }, booked] }), TRACKING_NUMBER);
    expect(waiting).toMatchObject({ status: 'pending', current_stage: 'registered' });
    expect(waiting.events?.map((event) => event.stage)).toEqual(['registered', 'registered']);
    const collected = parseInpostTrackingResponse(parcel({ status: 'FMD.1002', statusTitle: 'Parcel collected', trackingDetails: [booked,
      { status: 'FMD.1002', statusTitle: 'Parcel collected', datetime: '2026-05-02T10:00:00+02:00', place: 'Exampletown (IT)' }] }), TRACKING_NUMBER);
    expect(collected).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
    expect(collected.events?.map((event) => event.stage)).toEqual(['accepted', 'registered']);
    expect(statusMap.stage('FMD.1001', normalizeStatusWording('We will collect it soon'))).toBe('registered');
    expect(statusMap.stage('FMD.1001', normalizeStatusWording('Sent through Parcel Locker/Parcel Point'))).toBe('accepted');
    expect(statusMap.stage(null, normalizeStatusWording('We will collect it soon'))).toBe('registered');
  });

  it('leaves a UK parcel the hub knows only by its creation open to a fuller provider history', () => {
    const uk = `JJD${'0'.repeat(15)}2`;
    const created = { status: 'CRE.1001', statusTitle: 'Parcel created', datetime: '2026-05-01T08:00:00+01:00' };
    const waiting = parseInpostTrackingResponse(parcel({ trackingNumber: uk, status: 'CRE.1001', statusTitle: 'Parcel created', trackingDetails: [created] }), uk);
    expect(waiting).toMatchObject({ current_stage: 'registered', history_truncated: true });
    // A provider relaying InPost UK's tracker under InPost's UK name replaces it, so the parcel stays on its way.
    const relayed = { status: 'in_transit', current_stage: 'in_transit', discovered_carrier: 'inpost', tracking_provider: '17TRACK',
      last_status_text: 'We have your parcel', last_update: '2026-05-02T09:00:00+01:00', events: [
        { time: '2026-05-02T09:00:00+01:00', description: 'We have your parcel' },
        { time: '2026-05-01T08:00:00+01:00', description: 'Your parcel is on its way to InPost. Please check back for updates' },
      ] } satisfies CarrierResult;
    expect(fillPartialAnswer('inpost', uk, waiting, relayed)).toMatchObject({ current_stage: 'in_transit', tracking_provider: '17TRACK' });
    const received = parseInpostTrackingResponse(parcel({ trackingNumber: uk, status: 'MMD.1001', statusTitle: 'Parcel at our warehouse', trackingDetails: [created,
      { status: 'MMD.1001', statusTitle: 'Parcel at our warehouse', datetime: '2026-05-06T01:00:00+01:00', place: 'Exampletown (GB)' }] }), uk);
    expect(received.current_stage).toBe('accepted');
    expect(received.history_truncated).toBeUndefined();
    // The hub holds every scan of a parcel in InPost's own layout from its creation.
    const polish = parseInpostTrackingResponse(parcel({ status: 'CRE.1001', statusTitle: 'Parcel created', trackingDetails: [created] }), TRACKING_NUMBER);
    expect(polish.history_truncated).toBeUndefined();
  });

  it('reports unmapped codes as unknown with their raw wording preserved', () => {
    expect(classifyInpostStatus('NEW.9999')).toBeUndefined();
    const result = parseInpostTrackingResponse(parcel({
      status: 'NEW.9999',
      statusTitle: 'Something new',
      trackingDetails: [{ status: 'NEW.9999', statusTitle: 'Something new', datetime: '2026-05-04T10:00:00+02:00' }],
    }), TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Something new' });
    // No explicit mapping means no stage at all: the sync classifies the raw
    // wording and records where the final stage came from.
    expect(result.events?.[0]).toMatchObject({ description: 'Something new', provider_code: 'NEW.9999' });
    expect(result.events?.[0]?.stage).toBeUndefined();
  });

  it('keeps the stage a parcel had when InPost redirects it', () => {
    const redirect = { status: 'LMD.3013', statusTitle: 'Paczka przekierowana', datetime: '2026-05-04T10:20:00+02:00' };
    const created = { status: 'CRE.1001', statusTitle: 'Przesyłka utworzona', datetime: '2026-05-04T10:00:00+02:00' };
    const beforeHandover = parseInpostTrackingResponse(parcel({
      status: 'LMD.3013', statusTitle: 'Paczka przekierowana', trackingDetails: [redirect, created],
    }), TRACKING_NUMBER);
    expect(beforeHandover).toMatchObject({ status: 'pending', current_stage: 'registered', last_status_text: 'Paczka przekierowana' });
    expect(beforeHandover.events?.map((event) => event.stage)).toEqual(['registered', 'registered']);

    const posted = { status: 'FMD.1001', statusTitle: 'Nadana przez Paczkomat/PaczkoPunkt', datetime: '2026-05-05T09:00:00+02:00' };
    const later = { ...redirect, datetime: '2026-05-06T08:00:00+02:00' };
    const afterHandover = parseInpostTrackingResponse(parcel({
      status: 'LMD.3013', statusTitle: 'Paczka przekierowana', trackingDetails: [later, posted, redirect, created],
    }), TRACKING_NUMBER);
    expect(afterHandover).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
    expect(afterHandover.events?.map((event) => event.stage)).toEqual(['accepted', 'accepted', 'registered', 'registered']);

    // LMD.3014 is the same redirect under another code.
    const other = { ...redirect, status: 'LMD.3014' };
    expect(parseInpostTrackingResponse(parcel({ status: 'LMD.3014', statusTitle: 'Paczka przekierowana', trackingDetails: [other, created] }),
      TRACKING_NUMBER)).toMatchObject({ status: 'pending', current_stage: 'registered' });

    const alone = parseInpostTrackingResponse(parcel({ status: 'LMD.3013', trackingDetails: [redirect] }), TRACKING_NUMBER);
    expect(alone).toMatchObject({ status: 'unknown' });
    expect(alone.events?.[0]?.stage).toBeUndefined();
  });

  it("reads the logistics centre's receipt as the acceptance when nothing before it moved the parcel", () => {
    const created = { status: 'CRE.1001', statusTitle: 'Przesyłka utworzona', datetime: '2026-05-04T07:27:00+02:00' };
    const received = { status: 'MMD.1001', statusTitle: 'Przyjęta w Centrum Logistycznym', datetime: '2026-05-04T10:54:00+02:00' };
    const next = { ...received, datetime: '2026-05-04T23:11:00+02:00' };
    const first = parseInpostTrackingResponse(parcel({ status: 'MMD.1001', trackingDetails: [received, created] }), TRACKING_NUMBER);
    expect(first).toMatchObject({ status: 'in_transit', current_stage: 'accepted' });
    expect(first.events?.map((event) => event.stage)).toEqual(['accepted', 'registered']);
    const second = parseInpostTrackingResponse(parcel({ status: 'MMD.1001', trackingDetails: [next, received, created] }), TRACKING_NUMBER);
    expect(second).toMatchObject({ current_stage: 'in_transit' });
    expect(second.events?.map((event) => event.stage)).toEqual(['in_transit', 'accepted', 'registered']);
    // After a collection, the receipt is a step on the way.
    const collected = { status: 'FMD.1002', statusTitle: 'Odebrana od Nadawcy', datetime: '2026-05-04T09:00:00+02:00' };
    expect(parseInpostTrackingResponse(parcel({ status: 'MMD.1001', trackingDetails: [received, collected, created] }), TRACKING_NUMBER)
      .events?.map((event) => event.stage)).toEqual(['in_transit', 'accepted', 'registered']);
  });

  it('keeps the stage a parcel had through a delay notice', () => {
    const moving = { status: 'MMD.1004', statusTitle: 'On the way', datetime: '2026-05-04T13:00:00+02:00' };
    const delay = { status: 'INF.9001', statusTitle: 'Possible delivery delay', datetime: '2026-05-07T08:00:00+02:00' };
    const result = parseInpostTrackingResponse(parcel({
      status: 'INF.9001', statusTitle: 'Possible delivery delay', trackingDetails: [delay, moving],
    }), TRACKING_NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Possible delivery delay' });
    expect(result.events?.map((event) => event.stage)).toEqual(['in_transit', 'in_transit']);
  });

  it('rewords a scan stored in Polish in place, matched by its stage and place', () => {
    // The hub's Polish and English replies carry the same codes, clocks and places.
    const policy = sameInstantIdentityPolicy('inpost', { supportsScanMatching: true });
    const english = { stage: 'accepted', description: 'Collected by the Courier', location: '', providerCode: '' };
    expect(policy?.storedSources).toEqual(['inpost']);
    expect(policy?.matches?.(english, { ...english, description: 'Odebrana przez Kuriera' })).toBe(true);
    // A Polish reader's answer takes over the English rows the same way.
    expect(policy?.matches?.({ ...english, description: 'Odebrana przez Kuriera' }, english)).toBe(true);
    expect(policy?.matches?.(english, { ...english, description: 'Przesyłka utworzona', stage: 'registered' })).toBe(false);
    expect(policy?.matches?.(english, { ...english, location: 'Exampletown (PL)' })).toBe(false);
  });

  it('binds the returned tracking number to the requested shipment', () => {
    expect(() => parseInpostTrackingResponse(parcel({ trackingNumber: '640000000000000000000002' }), TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseInpostTrackingResponse(parcel({ trackingNumber: undefined }), TRACKING_NUMBER))
      .toThrow(SchemaError);
    expect(() => parseInpostTrackingResponse(null, TRACKING_NUMBER)).toThrow(SchemaError);
    expect(() => parseInpostTrackingResponse(parcel({ trackingDetails: {} }), TRACKING_NUMBER))
      .toThrow(SchemaError);
  });

  it('skips offset-less and malformed rows without losing the shipment', () => {
    const result = parseInpostTrackingResponse(parcel({
      trackingDetails: [
        { status: 'EOL.1001', statusTitle: 'Delivered', datetime: '2026-05-04 10:00:00' },
        { status: 'EOL.1001', statusTitle: 'Delivered', datetime: '2026-05-04T10:00:00+02:00' },
        { status: 'EOL.1001', statusTitle: 'Delivered', datetime: '2026-05-04T10:00:00+02:00' },
        { status: 'EOL.1001', statusTitle: '', datetime: '2026-05-04T10:00:00+02:00' },
        'not a record',
      ],
    }), TRACKING_NUMBER);
    // Empty description falls back to the code, so two rows survive the sparse input.
    expect(result.events?.map((event) => event.description)).toEqual(['Delivered', 'EOL.1001']);
  });

  it('reads the recipient and the signatory the hub names, without the phone', () => {
    const result = parseInpostTrackingResponse(parcel(), TRACKING_NUMBER);
    expect(result).toMatchObject({ receiver_name: 'Example Recipient', receiver_address: 'Musterstrasse 1, 10115 Berlin',
      signed_by: 'Example Signature' });
    const serialized = JSON.stringify(result);
    for (const secret of ['+490000000000', 'receiverPhone', 'countryCode']) {
      expect(serialized).not.toContain(secret);
    }
    // A signature that is an image or a link names no one.
    for (const signature of ['data:image/png;base64,AAAA', 'https://example.invalid/signature.png', '', 'x'.repeat(121)]) {
      expect(parseInpostTrackingResponse({ ...parcel(), signature }, TRACKING_NUMBER)).not.toHaveProperty('signed_by');
    }
    // Before the delivery nobody has signed.
    const waiting = parseInpostTrackingResponse({ ...parcel(), status: 'LMD.1004', statusTitle: 'Ready for pickup' }, TRACKING_NUMBER);
    expect(waiting).toMatchObject({ current_stage: 'ready_for_pickup', receiver_name: 'Example Recipient' });
    expect(waiting).not.toHaveProperty('signed_by');
  });

  it('produces every capability carrier.json declares', () => {
    expect(CAPABILITIES).toEqual(['history', 'location', 'delivered_at', 'pickup_point']);
    const result = parseInpostTrackingResponse(parcel(), TRACKING_NUMBER);
    expect(result.events?.some((event) => event.location)).toBe(true);
    expect(result.delivered_at).toBeTruthy();
    const shipx = JSON.parse(readFileSync(new URL('./fixtures/shipx-collected.json', import.meta.url), 'utf8'));
    expect(parseInpostPickup(shipx, TRACKING_NUMBER, result)).toBeTruthy();
  });
});

describe('InpostTracker fetch', () => {
  it('gets the hub URL for the normalized number and maps HTTP outcomes', async () => {
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(String(input));
      return response(parcel());
    });
    const result = await new InpostTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER);
    expect(result.status).toBe('delivered');
    expect(seen).toEqual([`https://inposteasy.com/api/tracking/${TRACKING_NUMBER}?language=en`,
      `https://api-shipx-pl.easypack24.net/v1/tracking/${TRACKING_NUMBER}`]);
  });

  it('asks the hub in Polish for a Polish reader and in English for anyone else', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(parcel()));
    const instance = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    for (const [language, url] of [['pl', ''], ['pl-PL', ''], ['de', '?language=en'], [null, '?language=en']] as const) {
      await instance.track({ number: TRACKING_NUMBER, language });
      const hub = fetcher.mock.calls.map(([input]) => String(input)).filter((seen) => seen.startsWith('https://inposteasy.com/'));
      expect(hub.at(-1)).toBe(`https://inposteasy.com/api/tracking/${TRACKING_NUMBER}${url}`);
    }
  });

  it('maps 404 to not-found and surfaces other failures distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(notFoundProblem(), 404));
    await expect(new InpostTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'NotFoundError', status: 404, message: 'InPost could not locate the shipment' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 503));
    await expect(new InpostTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', status: 503 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response('not json', 200));
    await expect(new InpostTracker({ timeoutMs: 1_000 }).fetch(TRACKING_NUMBER))
      .rejects.toThrow(TypeError);
    expect(() => new InpostTracker({ timeoutMs: 0 })).toThrow(TypeError);
    await expect(new InpostTracker({ timeoutMs: 1_000 }).fetch('nope'))
      .rejects.toThrow(InvalidInputError);
  });

  it.each(['', 'Tracking client failed. '])('recognizes the hub wrapper with prefix %j around an identity-bound not-found problem', async (prefix) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      type: '/errors/external/tracking-error', status: 404,
      instance: `/api/tracking/${TRACKING_NUMBER}`, detail: prefix + JSON.stringify(notFoundProblem()),
    }, 404));
    await expect(new InpostTracker({ fetcher }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'not_found', status: 404 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    '<html>Missing route</html>', {}, { ...notFoundProblem(), title: 'MAINTENANCE' },
    notFoundProblem('640000000000000000000002'),
    { type: '/errors/external/tracking-error', status: 404, instance: `/api/tracking/${TRACKING_NUMBER}`, detail: 'not json' },
    { type: '/errors/external/tracking-error', status: 404, instance: `/api/tracking/${TRACKING_NUMBER}`,
      detail: 'Tracking client failed. ' + JSON.stringify(notFoundProblem('640000000000000000000002')) },
  ])('keeps an unrecognized HTTP 404 inconclusive (%j)', async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(body, 404));
    await expect(new InpostTracker({ fetcher }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps HTTP 500 inconclusive even when its body resembles a not-found problem', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(notFoundProblem(), 500));
    await expect(new InpostTracker({ fetcher }).fetch(TRACKING_NUMBER))
      .rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([502, 503, 504])('recovers from HTTP %s with one bounded retry', async (status) => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({}, status))
      .mockResolvedValueOnce(response(parcel()));
    const result = new InpostTracker({ fetcher }).fetch(TRACKING_NUMBER);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([429, 500, 503])('preserves HTTP %s diagnostics and a long retry window without reclassifying it', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('Upstream unavailable', {
      status, headers: { 'Content-Type': 'text/plain', 'Retry-After': '120' },
    }));
    await expect(new InpostTracker({ fetcher }).fetch(TRACKING_NUMBER)).rejects.toMatchObject({
      name: 'UpstreamHttpError', status, retryAfterMs: 120_000,
      kind: status === 429 ? 'rate_limited' : status === 503 ? 'maintenance' : 'indeterminate',
      diagnostics: { body_excerpt: 'Upstream unavailable' },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('ends a transient retry wait when the caller cancels', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, 503));
    const failure = expect(new InpostTracker({ fetcher }).fetch(TRACKING_NUMBER, { signal: controller.signal }))
      .rejects.toMatchObject({ kind: 'maintenance', status: 503 });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await failure;
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

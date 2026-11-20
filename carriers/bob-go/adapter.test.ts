import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CARRIERS } from '../../core/catalog/index.js';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, BOB_GO_TRACKING, BobGoTracker } from './adapter.js';
import { bobGoRequestNumber } from './number.js';
import { bobGoMissing, parseBobGo } from './parser.js';
import { BOB_GO_STATES, bobGoStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The reference of a public review, and an invented one Bob Go holds nothing for.
const DELIVERED = 'UAE6ZK3X';
const UNKNOWN = 'UA000000';

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
type Shipment = Record<string, unknown> & { checkpoints: Record<string, unknown>[] };
const reply = () => JSON.parse(text('delivered')) as Shipment[];
const changed = (edit: (shipment: Shipment, all: Shipment[]) => void) => {
  const body = reply();
  edit(body[0]!, body);
  return JSON.stringify(body);
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
  { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const answering = (answer: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => answer());
const missing = (reference: string) => json(JSON.stringify({ message: JSON.stringify({ success: false,
  data: { message: `Shipment with reference ${reference} not found`, code: 500 } }) }), { status: 500 });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Bob Go HTTP adapter', () => {
  it('asks the tracker\'s service for the one reference, through the supplied transport', async () => {
    const fetcher = answering(() => json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new BobGoTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' uae6-zk3x ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(String(url)).toBe(`${BOB_GO_TRACKING}?tracking_reference=${DELIVERED}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init.method ?? 'GET').toBe('GET');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'bob-go', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered history newest first with its offsets, the merchant and the service', () => {
    const result = parseBobGo(text('delivered'), DELIVERED);
    const event = (time: string, description: string, code: string, stage: string) => ({ time, description, provider_code: code, stage,
      stage_source: 'carrier_map' });
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered: POD Details Captured', last_update: '2025-10-10T12:30:00+02:00', expected_delivery: null,
      delivered_at: '2025-10-10T12:30:00+02:00', sender_name: 'Prestoprint', service_name: 'ECO – Economy',
      events: [
        event('2025-10-10T12:30:00+02:00', 'Delivered: POD Details Captured', 'delivered', 'delivered'),
        event('2025-10-10T12:30:00+02:00', 'Delivered: POD file(s) captured', 'delivered', 'delivered'),
        event('2025-10-10T01:37:37+02:00', 'Out for delivery', 'out-for-delivery', 'out_for_delivery'),
        event('2025-10-09T13:59:00+02:00', 'In transit: Outbound to Julipo', 'in-transit', 'in_transit'),
        event('2025-10-09T00:33:45+02:00', 'At hub: At IE JHB hub', 'at-hub', 'in_transit'),
        event('2025-10-09T00:33:45+02:00', 'In transit: Inbound IE JHB from IE CPT', 'in-transit', 'in_transit'),
        event('2025-10-07T16:01:45+02:00', 'In transit: Outbound to IE JHB', 'in-transit', 'in_transit'),
        event('2025-10-07T15:45:28+02:00', 'At hub: At IE CPT hub', 'at-hub', 'in_transit'),
        event('2025-10-07T14:54:54+02:00', 'Collected', 'collected', 'accepted'),
        event('2025-10-07T14:32:56+02:00', 'Collection assigned: "On my way" SMS sent by the driver - 5 mins', 'collection-assigned', 'registered'),
        event('2025-10-07T11:54:18+02:00', 'Collection assigned', 'collection-assigned', 'registered'),
      ],
    });
  });

  it('never reads a PIN or the courier\'s phone, and names a filled estimate it does not read', () => {
    const result = parseBobGo(changed((shipment) => {
      shipment.pin = '4321';
      shipment.courier_phone = '000 000 0000';
      shipment.shipment_estimated_delivery_date_to = '2025-10-11';
    }), DELIVERED);
    expect(JSON.stringify(result)).not.toMatch(/4321|000 000 0000/);
    expect(result).not.toHaveProperty('pickup_code');
    expect(result.unread_estimates).toEqual(['shipment_estimated_delivery_date_to']);
  });

  it('lets the shipment\'s own state lead, keeps an unknown state visible and a repeated checkpoint once', () => {
    const cancelled = parseBobGo(changed((shipment) => {
      shipment.status = 'cancelled';
      shipment.status_friendly = 'Cancelled';
    }), DELIVERED);
    expect(cancelled).toMatchObject({ status: 'exception', current_stage: 'exception', current_stage_source: 'carrier_map',
      last_status_text: 'Cancelled', provider_code: 'cancelled' });
    expect(cancelled).not.toHaveProperty('delivered_at');

    const unread = parseBobGo(changed((shipment) => {
      shipment.status = 'xyzzy-state';
      shipment.checkpoints[0] = { ...shipment.checkpoints[0], status: 'xyzzy-state', status_friendly: 'Xyzzy', message: '' };
      shipment.checkpoints.push({ ...shipment.checkpoints[3]! });
    }), DELIVERED);
    expect(unread).toMatchObject({ current_stage: 'delivered', last_status_text: 'Xyzzy', delivered_at: '2025-10-10T12:30:00+02:00' });
    expect(unread).not.toHaveProperty('provider_code');
    expect(unread.events).toHaveLength(11);
    expect(unread.events![0]).toEqual({ time: '2025-10-10T12:30:00+02:00', description: 'Xyzzy', provider_code: 'xyzzy-state' });

    const silent = parseBobGo(changed((shipment) => {
      shipment.status = 'tracking-failed';
      shipment.checkpoints.unshift({ ...shipment.checkpoints[0], status: 'tracking-failed', status_friendly: 'Tracking failed',
        message: '', time: '2025-10-11 08:00:00+02:00' });
    }), DELIVERED);
    expect(silent).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Tracking failed' });
    expect(silent.events![0]).not.toHaveProperty('stage');
  });

  it('reads only the shipment filed under the whole reference', () => {
    expect(() => parseBobGo(text('delivered'), 'UAE6ZK3Y')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBobGo(changed((shipment, all) => { all.push({ ...shipment }); }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const other = changed((shipment, all) => { all.unshift({ ...shipment, shipment_tracking_reference: 'UAOTHER1', status: 'cancelled' }); });
    expect(parseBobGo(other, DELIVERED)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseBobGo(changed((shipment) => { shipment.checkpoints = []; }), DELIVERED))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
  });

  it('reads the HTTP 500 naming the reference as not found, and nothing else', async () => {
    expect(bobGoMissing(text('not-found'), UNKNOWN)).toBe(true);
    expect(bobGoMissing(text('not-found'), DELIVERED)).toBe(false);
    expect(bobGoMissing('{"message":"Internal server error"}', UNKNOWN)).toBe(false);
    expect(bobGoMissing('', UNKNOWN)).toBe(false);
    await expect(carrier(answering(() => json(text('not-found'), { status: 500 }))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(answering(() => missing('UA000001'))).track({ number: UNKNOWN })).rejects.toMatchObject({ name: 'UpstreamHttpError', status: 500 });
    await expect(carrier(answering(() => json('{"message":"Internal server error"}', { status: 500 }))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ name: 'UpstreamHttpError', status: 500 });
  });

  it('refuses a changed reply or clock, and reads a browser check as a challenge', () => {
    for (const body of ['{}', '[]', '[null]', 'null']) {
      expect(() => parseBobGo(body, DELIVERED), body).toThrow(expect.objectContaining({ kind: expect.stringMatching(/^(schema|indeterminate)$/) }));
    }
    expect(() => parseBobGo('[]', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const time of ['2025-10-31 25:00:00+02:00', '2025-10-10 12:30:00', '10/10/2025 12:30', '', 1760092200]) {
      expect(() => parseBobGo(changed((shipment) => { shipment.checkpoints[0]!.time = time; }), DELIVERED), String(time))
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseBobGo(changed((shipment) => { shipment.checkpoints[0]!.status = 'Delivered!'; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBobGo(changed((shipment) => { shipment.checkpoints[0]!.status_friendly = ''; shipment.checkpoints[0]!.message = ''; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBobGo(changed((shipment) => { shipment.checkpoints = 'none' as never; }), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseBobGo(CHALLENGE, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('keeps blocks, rate limits and moved routes apart from a missing reference', async () => {
    const lookup = (answer: () => Response) => carrier(answering(answer)).track({ number: DELIVERED });
    await expect(lookup(() => json(CHALLENGE))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('Forbidden', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(() => json('{}', { status: 429, headers: { 'Retry-After': '60' } }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(lookup(() => json('Not Found', { status: 404 }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(() => json('', { status: 301, headers: { Location: 'https://www.bobgo.co.za/' } }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('asks again once when Bob Go cannot be reached', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(text('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new BobGoTracker({ fetcher, recorder }).fetch(DELIVERED, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: DELIVERED }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('rejects input that is no reference, and pre-aborted lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', 'UAE6Z', 'UAE6ZK3é', 'U'.repeat(31), '1'.repeat(70)]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('recognizes a known reference and an unknown one as unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(text('delivered'))).mockResolvedValueOnce(json(text('not-found'), { status: 500 }));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toMatchObject({ known: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('answers a reference filed under Bob Go', async () => {
    const fetcher = answering(() => json(text('delivered')));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'bob-go' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'bob-go', source: 'bob-go', result: { current_stage: 'delivered' } });
  });
});

describe('Bob Go references', () => {
  it('takes the reference in capitals without spaces or hyphens', () => {
    for (const number of [DELIVERED, 'uae6zk3x', 'UAE6 ZK3X', 'UAE6-ZK3X']) expect(bobGoRequestNumber(number)).toBe(DELIVERED);
  });

  it('claims no reference, so recognition never offers Bob Go', () => {
    expect(detectCarrierMatch(DELIVERED).candidates).not.toContain('bob-go');
    expect(recognitionCandidates(DELIVERED).map(({ carrier: id }) => id)).not.toContain('bob-go');
  });

  it('opens the tracker on the reference, and reads it back from the link', () => {
    const url = CARRIERS['bob-go'].trackingUrl!(DELIVERED);
    expect(url).toBe(`https://track.bobgo.co.za/${DELIVERED}`);
    expect(parseTrackingInput(url)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'bob-go' });
  });
});

describe('Bob Go status vocabulary', () => {
  it('stages every recorded state as the map does', () => {
    for (const entry of statuses.entries as { code: string; wording: string; stage: string | null }[]) {
      if (entry.stage === null) {
        expect(bobGoStage(entry.code, entry.wording), entry.code).toBeNull();
        expect(statusMapAnswer({ carrier: 'bob-go', providerCode: entry.code, description: entry.wording }).kind, entry.code).toBe('intentional_gap');
        continue;
      }
      expect(bobGoStage(entry.code, entry.wording), entry.code).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'bob-go', providerCode: entry.code, description: entry.wording }), entry.code)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(Object.keys(BOB_GO_STATES).every((code) => statuses.entries.some((entry) => entry.code === code))).toBe(true);
    expect(statusMap.stage(null, 'delivered')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'bob-go', providerCode: 'xyzzy', description: 'Xyzzy' })).toEqual({ kind: 'unknown' });
  });
});

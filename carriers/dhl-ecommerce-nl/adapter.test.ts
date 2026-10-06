import { describe, expect, it } from 'vitest';
import { InvalidInputError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import fixture from './fixtures/collected.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import { DhlEcommerceNlTracker, adapter } from './adapter.js';
import { normalizeDhlEcommerceNlNumber, parseDhlEcommerceNl, parseDhlEcommerceNlNotFound } from './parser.js';
import { dhlEcommerceNlStatus } from './status.js';

const NUMBER = 'JVGL09999999000000000000';
const MISSING = 'No parcel found for the given key(s)';
const clone = () => structuredClone(fixture);
const environment = (fetcher: typeof fetch) => ({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher });

describe('DHL eCommerce Netherlands parser', () => {
  it('reads a parcel collected at a ServicePoint, newest scan first', () => {
    const result = normalizeCarrierResult(parseDhlEcommerceNl(clone(), NUMBER));
    expect(result.status).toBe('delivered');
    expect(result.current_stage).toBe('delivered');
    expect(result.last_status_text).toBe('Collected at DHL ServicePoint by the recipient');
    expect(result.last_update).toBe('2026-04-03T10:42:00.269Z');
    expect(result.delivered_at).toBe('2026-04-03T10:42:00.269Z');
    expect(result.expected_delivery).toBeNull();
    expect(result.events).toHaveLength(11);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'COLLECTED_AT_PARCELSHOP', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events?.at(-1)).toMatchObject({ provider_code: 'PRENOTIFICATION_RECEIVED', stage: 'registered' });
    expect(result.events?.map((event) => event.stage)).toEqual(['delivered', 'ready_for_pickup', 'in_transit', 'in_transit',
      'failed_attempt', 'out_for_delivery', 'in_transit', 'in_transit', 'accepted', 'registered', 'registered']);
  });

  it('keeps the planned day while the parcel is on its way', () => {
    const payload = clone();
    payload[0]!.events = payload[0]!.events.slice(0, 6);
    delete (payload[0] as { deliveredAt?: string }).deliveredAt;
    const result = parseDhlEcommerceNl(payload, NUMBER);
    expect(result.status).toBe('out_for_delivery');
    expect(result.expected_delivery).toBe('2026-04-02');
    expect(result.delivered_at).toBeUndefined();
  });

  it('does not let a later notice undo a delivery', () => {
    const payload = clone();
    payload[0]!.events.push({ category: 'UNDERWAY', localTimestamp: '2026-04-03T13:00:00+02:00', leg: { network: 'ECOMMERCE' },
      status: 'IMAGE_AVAILABLE', timestamp: '2026-04-03T11:00:00Z', type: 'PIECE_EVENT' });
    const result = parseDhlEcommerceNl(payload, NUMBER);
    expect(result.current_stage).toBe('delivered');
    expect(result.last_update).toBe('2026-04-03T11:00:00Z');
  });

  it('drops a scan the feed repeats and files an unknown code under its category', () => {
    const payload = clone();
    payload[0]!.events.splice(4, 0, structuredClone(payload[0]!.events[3]!));
    payload[0]!.events[1]!.status = 'SOME_NEW_CODE';
    const result = parseDhlEcommerceNl(payload, NUMBER);
    expect(result.events).toHaveLength(11);
    expect(result.events?.at(-2)).toMatchObject({ provider_code: 'SOME_NEW_CODE', description: 'Some new code', stage: 'registered' });
    expect(dhlEcommerceNlStatus('SOME_NEW_CODE', 'SOMETHING_ELSE')).toEqual({ description: 'Some new code' });
  });

  it('requires the answer to name the requested parcel', () => {
    const wrong = clone();
    wrong[0]!.barcode = 'JVGL09999999000000000001';
    wrong[0]!.barcodes = ['JVGL09999999000000000001'];
    expect(() => parseDhlEcommerceNl(wrong, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDhlEcommerceNl([...clone(), ...clone()], NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDhlEcommerceNl({}, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const empty = clone();
    empty[0]!.events = [];
    expect(() => parseDhlEcommerceNl(empty, NUMBER)).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads absence only from the gateway\'s own sentence', () => {
    expect(() => parseDhlEcommerceNlNotFound(MISSING)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseDhlEcommerceNlNotFound('<html>Not Found</html>')).toThrowError(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('accepts the Benelux label families only', () => {
    expect(normalizeDhlEcommerceNlNumber('jvgl 0999 9999 0000 0000 0000')).toBe(NUMBER);
    expect(normalizeDhlEcommerceNlNumber('3SABCD012345678')).toBe('3SABCD012345678');
    expect(normalizeDhlEcommerceNlNumber('JJD0099999999')).toBe('JJD0099999999');
    expect(() => normalizeDhlEcommerceNlNumber('00340434000000000000')).toThrow(InvalidInputError);
    expect(() => normalizeDhlEcommerceNlNumber('1234567890')).toThrow(InvalidInputError);
  });

  it('gives every recorded code a wording and a known stage', () => {
    expect(statuses.entries.length).toBeGreaterThan(300);
    for (const entry of statuses.entries) {
      expect(STAGES).toContain(entry.stage);
      expect(dhlEcommerceNlStatus(entry.code, 'UNKNOWN')).toEqual({ description: entry.wording, stage: entry.stage });
    }
  });
});

describe('DHL eCommerce Netherlands adapter', () => {
  it('asks the gateway for the one key and returns a normalized parcel', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls += 1;
      const request = new URL(String(url));
      expect(request.origin + request.pathname).toBe('https://api-gw.dhlparcel.nl/track-trace');
      expect([...request.searchParams]).toEqual([['key', NUMBER]]);
      expect(init?.signal).toBeDefined();
      return Response.json(clone());
    };
    const result = normalizeCarrierResult(await new DhlEcommerceNlTracker({ fetcher }).fetch(NUMBER));
    expect(result.current_stage).toBe('delivered');
    expect(calls).toBe(1);
  });

  it('recognizes a known parcel, an absent one, and leaves other errors inconclusive', async () => {
    const known = adapter(environment(async () => Response.json(clone())));
    await expect(known.recognize?.(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: '2026-04-03T10:42:00.269Z' });
    const unknown = adapter(environment(async () => new Response(MISSING, { status: 404 })));
    await expect(unknown.recognize?.(NUMBER)).resolves.toEqual({ known: false });
    await expect(unknown.recognize?.('00340434000000000000')).resolves.toEqual({ known: false });
    const generic = adapter(environment(async () => new Response('Not Found', { status: 404 })));
    await expect(generic.recognize?.(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    const limited = adapter(environment(async () => new Response('', { status: 429 })));
    await expect(limited.track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});

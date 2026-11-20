import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, HellmannTracker } from './adapter.js';
import { hellmannPackageUrl, normalizeHellmannPackage, parseHellmannPackage } from './parser.js';
import { hellmannStage } from './status.js';

const NUMBER = '00937284651028374650', OTHER = '00000000000000000017';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/summary.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const parse = (value: unknown = fixture, number = NUMBER) => parseHellmannPackage(JSON.stringify(value), number);
const page = () => new Response(JSON.stringify(fixture), { headers: { 'Content-Type': 'application/json' } });
const make = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Hellmann anonymous road package summary', () => {
  it('preserves the explicit current status and offset-free last-change clock without inventing scans', () => {
    const result = parse();
    expect(result).toMatchObject({ current_stage: 'delivered', status: 'delivered', summary_only: true,
      last_status_text: 'DELIVERED', last_update: null, last_update_local: '2026-02-10T08:58:00', events: [], expected_delivery: null });
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC|56012345678|consignor|consignee|nve/);
  });

  it('requires the exact whole package among the carrier result collis, not a URL or shipment reference echo', () => {
    expect(() => parse(fixture, OTHER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture, collis: [{ nve: OTHER }], depShipmentNumber: NUMBER })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture, collis: [{ nve: NUMBER }, { nve: NUMBER }] })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture, collis: [{ nve: Number(NUMBER) }] })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('requires a supported shipment structure and bounded package list', () => {
    for (const changed of [null, [], {}, { ...fixture, internalShipmentId: '' }, { ...fixture, internalShipmentId: 56012345678 },
      { ...fixture, collis: [] }, { ...fixture, collis: Array.from({ length: 101 }, () => ({ nve: NUMBER })) },
      { ...fixture, roadTransportPlanIcons: {} }, { ...fixture, roadStatusFilter: 'delivered' }]) {
      expect(() => parse(changed)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('does not turn contradictory or unsupported road states into delivery', () => {
    expect(() => parse({ ...fixture, roadTransportPlanIcons: { shipmentDeliveredIcon: false } }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture, roadStatusFilter: 'OPEN' })).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const wording of ['OPEN', 'ON_SCHEDULE', 'IN_DELIVERY', 'IN_CLARIFICATION', 'SAMPLE_NEW_STATUS']) {
      expect(hellmannStage(wording)).toBeNull();
      expect(parse({ ...fixture, roadStatusFilter: wording, roadTransportPlanIcons: { shipmentDeliveredIcon: false } }))
        .toMatchObject({ current_stage: 'unknown', summary_only: true, events: [] });
    }
  });

  it('does not borrow a sibling package delivery from the shipment summary', () => {
    expect(() => parse({ ...fixture, collis: [{ nve: OTHER, status: 'DELIVERED' }, { nve: NUMBER, status: 'IN_TRANSIT' }] }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture, collis: [{ nve: OTHER, status: 'IN_TRANSIT' }, { nve: NUMBER, status: 'DELIVERED' }] }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture, collis: [{ nve: OTHER, status: 'DELIVERED' }, { nve: NUMBER, status: 'DELIVERED' }] }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(parse({ ...fixture, collis: [{ nve: NUMBER }] }))
      .toMatchObject({ current_stage: 'delivered', summary_only: true, events: [] });
    expect(() => parse({ ...fixture, collis: [{ nve: NUMBER, status: 'IN_TRANSIT' }] }))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parse({ ...fixture, collis: [{ nve: NUMBER, status: 42 }] }))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('validates the raw calendar clock and preserves any explicit offset', () => {
    for (const clock of ['', null, '2026-02-30T08:58:00', '2026-02-10', '2026-02-10T25:58:00', '10.02.2026 08:58', '2026-02-10T08:58:00 garbage']) {
      expect(() => parse({ ...fixture, latestActualDateTime: clock })).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    for (const clock of ['2026-02-10T08:58:00Z', '2026-02-10T08:58:00+02:00', '2026-02-10T08:58:00.123-03:00']) {
      expect(parse({ ...fixture, latestActualDateTime: clock })).toMatchObject({ last_update: clock, last_update_local: clock, events: [] });
    }
  });

  it('keeps blocked HTML and malformed JSON distinct from a missing shipment', () => {
    expect(() => parseHellmannPackage('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    for (const text of ['<html>unfinished</html>', '{}', '{"error":"synthetic missing"}']) {
      expect(() => parseHellmannPackage(text, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('uses one supplied whole-NVE guest request, with no auth, postcode, POD or form session', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://public-road.tracking.hellmann.net');expect(url.pathname).toBe('/public/api/v1/road/search');
      expect([...url.searchParams]).toEqual([['hps.collino', NUMBER]]);
      expect(init?.method ?? 'GET').toBe('GET');expect(init?.body).toBeUndefined();expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);expect(new Headers(init?.headers).has('Cookie')).toBe(false);
      return page();
    });
    expect((await new HellmannTracker({ fetcher }).fetch(NUMBER, { budgetMs: 5000 })).summary_only).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves HTTP failure and rate-limit categories rather than finalizing an unbound 404', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"synthetic not found"}', { status: 404 }));
    await expect(make(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport', status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const limited = vi.fn<typeof fetch>().mockResolvedValue(new Response('synthetic limited', { status: 429, headers: { 'Retry-After': '5' } }));
    await expect(make(limited).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 5000 });
  });

  it('rejects out-of-scope identifiers and pre-cancelled requests before egress', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const raw of ['', '12345678', '1'.repeat(20), '00' + '1'.repeat(19), 'https://other.invalid/track']) {
      expect(() => normalizeHellmannPackage(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(normalizeHellmannPackage(NUMBER.replace(/(.{4})/g, '$1 '))).toBe(NUMBER);
    expect(new URL(hellmannPackageUrl(NUMBER)).searchParams.get('hps.collino')).toBe(NUMBER);
    await expect(make(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serves a selected package through the facade without promoting SSCC shape to carrier ownership', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(page());
    expect(await createTracker({ fetcher, providers: [], env: {} }).track({ number: NUMBER, carrier: 'hellmann' }, { budgetMs: 5000 }))
      .toMatchObject({ source: 'hellmann', carrier: 'hellmann', result: { current_stage: 'delivered', summary_only: true, events: [], last_update_local: '2026-02-10T08:58:00' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

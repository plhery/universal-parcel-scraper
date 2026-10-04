import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EkartTracker } from './adapter.js';
import { parseEkart } from './parser.js';
const NUMBER = 'FMPP0000000001';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));

describe('Ekart parser', () => {
  it('binds the map key and preserves dated history and ETA', () => {
    const result = parseEkart(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: '2026-01-03T16:00:00Z', delivered_at: '2026-01-03T16:00:00Z', expected_delivery: '2026-01-03T16:00:00Z' });
    expect(result.events).toHaveLength(3);
    expect(result.events?.[2]).toMatchObject({ stage: 'registered', stage_source: 'carrier_map', description: 'Pickup Requested' });
  });
  it('rejects mixed identities and malformed rows', () => {
    const value = fixture(); value.OTHER0000000001 = value[NUMBER];
    expect(() => parseEkart(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const wrong = fixture(); wrong.FMPP9999999999 = wrong[NUMBER]; delete wrong[NUMBER];
    expect(() => parseEkart(wrong, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const row of [null, {}, { date: 1767456000000, statusDetails: {} }]) {
      const value = fixture(); value[NUMBER].shipmentTrackingDetails[0] = row;
      expect(() => parseEkart(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
  it('keeps unknown history and unresolved clocks inconclusive without inventing 1970 dates', () => {
    expect(() => parseEkart({}, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const value = fixture(); value[NUMBER].shipmentTrackingDetails = [];
    expect(() => parseEkart(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    value[NUMBER].shipmentTrackingDetails = [{ date: 1767456000, statusDetails: 'New operation', city: 'Example depot' }];
    expect(parseEkart(value, NUMBER)).toMatchObject({ status: 'unknown', last_update: null, events: [{ provider_time_text: '1767456000' }] });
    expect(parseEkart(value, NUMBER).current_stage).toBeUndefined();
  });
  it('retains the provider newest scan when its clock is unresolved', () => {
    const value = fixture(); value[NUMBER].shipmentTrackingDetails.at(-1).date = 'unknown';
    const result = parseEkart(value, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null });
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', provider_time_text: 'unknown' });
    expect(result.delivered_at).toBeUndefined();
  });
  it('deduplicates rows, bounds history and validates every retained input row', () => {
    const value = fixture(); value[NUMBER].shipmentTrackingDetails.push(value[NUMBER].shipmentTrackingDetails[0]);
    expect(parseEkart(value, NUMBER).events).toHaveLength(3);
    value[NUMBER].shipmentTrackingDetails = Array.from({ length: 1001 }, () => value[NUMBER].shipmentTrackingDetails[0]);
    expect(() => parseEkart(value, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});
describe('Ekart retrieval', () => {
  it('bootstraps separate CSRF cookie sessions and forwards host identity', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).includes('/shipmenttrack/')) {
        const response = new Response('<meta name="csrf-token" content="synthetic-csrf">', { headers: { 'Set-Cookie': 'session=synthetic-session; Path=/; Secure' } });
        Object.defineProperty(response, 'url', { value: String(url) }); return response;
      }
      expect(new Headers(init?.headers).get('Cookie')).toContain('session=synthetic-session');
      return new Response(JSON.stringify(fixture()));
    });
    await new EkartTracker({ fetcher, userAgent: 'Synthetic tracker' }).fetch(NUMBER);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('https://ekartlogistics.com/ekartlogistics-web-routes-api/ekartlogistics-web-proxy/trackings/v2');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ tracking_ids: NUMBER }), cache: 'no-store', redirect: 'manual' });
    expect(new Headers(init?.headers).get('csrf-token')).toBe('synthetic-csrf');
    expect(new Headers(init?.headers).get('x-user-agent')).toBe('Synthetic tracker EKCL/website/1');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('keeps a session reset separate from unknown parcel history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 205 }));
    await expect(new EkartTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });
  it('does no I/O for invalid or aborted input, and bounds bootstrap bodies', async () => {
    const unused = vi.fn<typeof fetch>();
    await expect(new EkartTracker({ fetcher: unused }).fetch('123')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(new EkartTracker({ fetcher: unused }).fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(500_001)));
    await expect(new EkartTracker({ fetcher: oversized }).fetch(NUMBER)).rejects.toThrow('unexpectedly large');
  });
});

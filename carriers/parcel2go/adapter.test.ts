import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseParcel2Go } from './parser.js';

const number = 'P2G118684634';
const delivered = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const absent = JSON.parse(readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8'));

describe('Parcel2Go guest tracking', () => {
  it('binds the P2G order line and retains its cross-border wall clocks', () => {
    const result = parseParcel2Go(delivered, number);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: null, last_status_text: 'Item delivered' });
    expect(result.events).toHaveLength(16);
    expect(result.events?.[0]).toMatchObject({
      description: 'Item delivered', stage: 'delivered', provider_code: '97664C9B', local_time: '2023-11-22T10:08:21',
      location: 'BRSI394',
    });
    expect(result.events?.[6]).toMatchObject({ stage: 'customs', local_time: '2023-10-23T07:14:11' });
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
  });

  it('keeps an unfinished piece current when another piece is delivered', () => {
    const reply = structuredClone(delivered);
    const deliveredPiece = reply.result.parcels['H00MTA0007127809'];
    reply.result.parcels.second = { delivered: false, events: [deliveredPiece.events[2]] };
    reply.result.parcelCount = 2;
    const result = parseParcel2Go(reply, number);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Item has been sorted', history_truncated: true });
    expect(result.events).toHaveLength(1);
  });

  it('rejects a different order line, an incomplete parcel list and an unrelated error', () => {
    expect(() => parseParcel2Go(delivered, 'P2G000000000')).toThrow(/identify the requested reference/);
    const reply = structuredClone(delivered);
    reply.result.parcelCount = 2;
    expect(() => parseParcel2Go(reply, number)).toThrow(/incomplete list of parcels/);
    expect(() => parseParcel2Go({ success: false, error: { code: '500' }, result: null }, number)).toThrow(/invalid tracking response/);
  });

  it('only treats the native order-line miss as not found', () => {
    expect(() => parseParcel2Go(absent, 'P2G000000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('sends just the reference and the caller transport context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(delivered));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, userAgent: 'Test agent', fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: number.toLowerCase() }, { budgetMs: 2_000, signal: new AbortController().signal }))
      .resolves.toMatchObject({ status: 'delivered' });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://www.parcel2go.com/.api/tracking/PARCEL2GO.UK.LIVE/tracking/${number}?postcode=&findMostRecentParcelTracking=true`);
    expect(new Headers(request?.headers).get('user-agent')).toBe('Test agent');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    await expect(tracker.track({ number: '12345678' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves a challenge page as a challenge', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('<title>Just a moment</title>'));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number })).rejects.toMatchObject({ kind: 'challenge' });
  });
});

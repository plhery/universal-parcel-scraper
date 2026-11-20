import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseAirEuropaCargo } from './parser.js';

const transitNumber = '996-13146151';
const deliveryNumber = '996-12345675';
const unknownNumber = '996-12345678';
const transit = readFileSync(new URL('./fixtures/transfer.html', import.meta.url), 'utf8');
const delivered = readFileSync(new URL('./fixtures/delivered-example.html', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.html', import.meta.url), 'utf8');

describe('Air Europa Cargo guest tracking', () => {
  it('reads dated operations, preserves wall times and deduplicates exact scans', () => {
    const result = parseAirEuropaCargo(transit, transitNumber);
    expect(result).toMatchObject({
      current_stage: 'in_transit', last_status_text: 'FOW',
      last_update: null, last_update_local: '2024-07-22T17:25:00',
    });
    expect(result.events).toHaveLength(14);
    expect(result.events?.[0]).toEqual({
      local_time: '2024-07-22T17:25:00', description: 'FOW', provider_code: 'FOW',
      stage: 'in_transit', stage_source: 'carrier_map',
    });
    expect(result.events).toContainEqual({
      local_time: '2024-07-21T18:21:00', description: 'Received MAD GHA', location: 'MAD',
      stage: 'in_transit', stage_source: 'carrier_map',
    });
    expect(result.events?.find(e => e.provider_code === 'NFD')?.stage).toBeUndefined();
    expect(result.events?.find(e => e.provider_code === 'DIS')?.stage).toBe('exception');
    expect(result.events?.find(e => e.description === 'Ready for Carriage')?.stage).toBe('in_transit');
  });

  it('marks a cargo delivery independently of the document handling rows', () => {
    const result = parseAirEuropaCargo(delivered, deliveryNumber);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_update_local: '2023-02-16T14:24:00',
    });
    expect(result.events?.[0]).toMatchObject({ description: 'Delivery', location: 'PMI' });
    expect(result.events?.find(e => e.provider_code === 'AWD')?.stage).toBeUndefined();
    expect(result.events?.find(e => e.description === 'Ready for Carriage')?.stage).toBe('accepted');
  });

  it('keeps shipment misses distinct from unrelated markup and mismatched responses', () => {
    expect(() => parseAirEuropaCargo(absent, unknownNumber)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseAirEuropaCargo(absent, transitNumber)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseAirEuropaCargo(delivered, transitNumber)).toThrow(/did not identify the requested/);
    expect(() => parseAirEuropaCargo('<p>No shipment</p>', transitNumber)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('rejects an invalid scan clock and distinguishes a listing without operations', () => {
    expect(() => parseAirEuropaCargo(transit.replace('17:25', '24:25'), transitNumber))
      .toThrow(/undated or incomplete scan/);
    expect(() => parseAirEuropaCargo(transit.slice(0, transit.indexOf('</table>') + 8), transitNumber))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('sends the two fields of a printed air waybill with the configured fetch context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(transit));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: '996 / 1314 6151' }, { budgetMs: 2_000, signal: new AbortController().signal }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.uxtracking.com/tracking.asp');
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe('prefix=996&Serial=13146151');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    await expect(tracker.track({ number: '055-13146151' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reports a verification response as a challenge', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('Forbidden', { status: 403 }));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: transitNumber })).rejects.toMatchObject({ kind: 'challenge' });
  });
});

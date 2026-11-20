import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseNavlungo } from './parser.js';

const deliveredNumber = 'JPBGJN6QK6PL';
const delivered = readFileSync(new URL('./fixtures/delivered.rsc', import.meta.url), 'utf8');
const absent = readFileSync(new URL('./fixtures/not-found.rsc', import.meta.url), 'utf8');

describe('Navlungo domestic guest tracking', () => {
  it('reports the parcel and keeps wall-clock scans from the delivery history', () => {
    const result = parseNavlungo(delivered, deliveredNumber);
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', last_update: null });
    expect(result.events).toHaveLength(5);
    expect(result.events?.[0]).toMatchObject({
      stage: 'delivered', local_time: '2026-10-23T21:02:18', description: 'Teslim Edildi', provider_code: '2',
    });
    expect(result.events?.[4]).toMatchObject({ stage: 'registered', provider_code: '1' });
    expect(result.delivered_at).toBeUndefined();
    expect(result.events?.every(event => event.local_time && !event.time)).toBe(true);
  });

  it('checks the requested delivery number and classifies only the native miss as not found', () => {
    expect(() => parseNavlungo(delivered, 'ZZZ000000ZZZ')).toThrow(/uniquely identify the requested parcel/);
    expect(() => parseNavlungo(delivered + delivered, deliveredNumber)).toThrow(/uniquely identify the requested parcel/);
    expect(() => parseNavlungo(absent, deliveredNumber)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseNavlungo('1:E{"digest":"NETWORK_ERROR"}\n', deliveredNumber))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('parses the shipment row independently of its component and row IDs', () => {
    const row = delivered.replace(/^[a-f0-9]+:/, '9d:').replace(/"\$L[0-9a-f]+"/, '"$L99"');
    expect(parseNavlungo(row, deliveredNumber).current_stage).toBe('delivered');
  });

  it('requests the public tracking route with the normalized delivery number and caller context', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(delivered, { headers: { 'Content-Type': 'text/x-component' } }));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, userAgent: 'Test agent', fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: deliveredNumber.toLowerCase() }, { budgetMs: 2_000, signal: new AbortController().signal }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://domestic-track.navlungo.com/en/check/JPBGJN6QK6PL/?_rsc');
    expect(new Headers(request?.headers).get('rsc')).toBe('1');
    expect(new Headers(request?.headers).get('user-agent')).toBe('Test agent');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    await expect(tracker.track({ number: 'invalid' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a challenge and a route error from a missing shipment', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response('<title>Just a moment</title>', { status: 403 }))
      .mockImplementationOnce(async () => new Response('<title>404</title>', { status: 404 }));
    const tracker = adapter({ env: {}, recorder: NOOP_RECORDER, fetcher, trawl: null, browserExecutablePath: null });
    await expect(tracker.track({ number: deliveredNumber })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(tracker.track({ number: deliveredNumber })).rejects.toMatchObject({ kind: 'schema' });
  });
});

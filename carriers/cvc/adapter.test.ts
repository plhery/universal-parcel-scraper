import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const number = '91691785';
const sample = readFileSync(new URL('./fixtures/sample.html', import.meta.url), 'utf8');
const unknown = readFileSync(new URL('./fixtures/unknown.html', import.meta.url), 'utf8');

describe('CVC tracking', () => {
  it('reads the requested waybill and its scans from the public tracking page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(sample));
    const result = await adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher }).track({ number }, {});
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('wb')).toBe(number);
    expect(result.current_stage).toBe('delivered');
    expect(result.events).toHaveLength(9);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-10-26T19:40:25', stage: 'delivered' });
    expect(result.events?.[1]?.stage).toBe('out_for_delivery');
  });

  it('rejects a different waybill and keeps browser checks distinct from an unknown shipment', () => {
    expect(() => parseTracking(sample, number.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(unknown, number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<title>Just a moment</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
});

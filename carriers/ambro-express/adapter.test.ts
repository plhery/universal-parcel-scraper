import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import sample from './fixtures/sample.json' with { type: 'json' };
import unknown from './fixtures/unknown.json' with { type: 'json' };
import { parseTracking } from './parser.js';

describe('Ambro Express tracking', () => {
  it('submits one shipment and reads its Polish scans newest first', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(sample));
    const result = await adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher }).track({ number: '2060002762700' }, {});
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toBe('_token=send&shippingNumber=2060002762700');
    expect(result.current_stage).toBe('delivered');
    expect(result.events).toHaveLength(9);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-09-03T11:39:30', stage: 'delivered' });
    expect(result.events?.at(-1)?.stage).toBe('registered');
  });

  it('distinguishes an unknown number, a browser check, and a missing result table', () => {
    expect(() => parseTracking(JSON.stringify(unknown))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<title>Just a moment</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTracking(JSON.stringify({ ...sample, content: { ...sample.content, content: '' } }))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

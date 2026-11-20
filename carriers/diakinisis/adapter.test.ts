import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import sample from './fixtures/sample.json' with { type: 'json' };
import unknown from './fixtures/unknown.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = 'D60664020370603';

describe('Diakinisis tracking', () => {
  it('posts the order number alone and retains dated scans', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(sample));
    const result = await adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher })
      .track({ number }, {});
    const form = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(form.get('trackingId')).toBe(number);
    expect(form.get('secondId')).toBe('');
    expect(result.current_stage).toBe('delivered');
    expect(result.events).toHaveLength(6);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-07-23T15:20:42', stage: 'delivered' });
  });

  it('requires the carrier to echo the number and distinguishes a missing order from a failure', () => {
    expect(() => parseTracking(JSON.stringify(sample), number.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(JSON.stringify(unknown), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('["0","Service unavailable",[]]', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

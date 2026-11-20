import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const number = '2375184';
const sample = readFileSync(new URL('./fixtures/sample.html', import.meta.url), 'utf8');
const unknown = readFileSync(new URL('./fixtures/unknown.html', import.meta.url), 'utf8');

describe('Interlogistica tracking', () => {
  it('posts one waybill and reads its operations and places', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(sample));
    const result = await adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher })
      .track({ number }, {});
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toBe('edTrackingNumber=2375184');
    expect(result.current_stage).toBe('returned');
    expect(result.events).toHaveLength(7);
    expect(result.events?.[0]).toMatchObject({ local_time: '2022-03-08T15:36:00', location: 'ВАРНА', stage: 'returned' });
    expect(result.events?.[3]?.stage).toBeUndefined();
  });

  it('requires the waybill result and treats an empty result as a distinct reply', () => {
    expect(() => parseTracking(sample.replace('<b>2375184</b>', '<b>237518</b>'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(unknown, 'S6NOSHIPMENTFIRST')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking('<title>Just a moment</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
});

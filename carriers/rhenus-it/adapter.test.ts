import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const number = '295983226-01';
const sample = readFileSync(new URL('./fixtures/sample.html', import.meta.url), 'utf8');
const unavailable = readFileSync(new URL('./fixtures/unavailable.html', import.meta.url), 'utf8');

describe('Rhenus Italia home-delivery tracking', () => {
  it('restores the public shipment separator after package input normalization', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(sample));
    const result = await adapter({ trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER, fetcher })
      .track({ number: directTrackingNumber('rhenus-it', number) }, {});
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('s')).toBe(number);
    expect(result.current_stage).toBe('delivered');
    expect(result.events).toHaveLength(8);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-02-09T11:38:00', stage: 'delivered' });
    expect(result.events?.[2]?.stage).toBe('pending');
  });

  it('keeps an unavailable tracker distinct from an identity mismatch', () => {
    expect(() => parseTracking(sample, number.slice(0, -1))).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(unavailable, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('<title>Just a moment</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });
});

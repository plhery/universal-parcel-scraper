import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.TFMXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('TFMXpress live retrieval', () => {
  it('retrieves the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'tfmxpress' });
    expect(answer).toMatchObject({ carrier: 'tfmxpress', source: 'tfmxpress' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tfmxpress', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time && event.time && event.time_zone_basis)).toBe(true);
    expect(result.events.every((event) => Date.parse(event.time!) <= Date.now())).toBe(true);
    expect(result.events.some((event) => event.location)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.TFMXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.TFMXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

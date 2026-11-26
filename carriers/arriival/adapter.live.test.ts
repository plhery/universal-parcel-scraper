import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.ARRIIVAL_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Arriival live retrieval', () => {
  it('retrieves the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'arriival' });
    expect(answer).toMatchObject({ carrier: 'arriival', source: 'arriival' });
    expect(answer.attempts[0]).toMatchObject({ source: 'arriival', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Scans on their wall clocks, each with the tracker's code.
    expect(result.events.every((event) => event.provider_code && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  });

  it.skipIf(!process.env.ARRIIVAL_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ARRIIVAL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

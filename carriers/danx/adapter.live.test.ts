import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another barcode is given.
const NUMBER = process.env.DANX_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('DANX live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'danx' });
    expect(answer).toMatchObject({ carrier: 'danx', source: 'danx' });
    expect(answer.attempts[0]).toMatchObject({ source: 'danx', kind: 'ok' });
    const { result } = answer;
    expect(result.provider_code).toMatch(/^[A-Z][A-Z0-9]{1,7}$/);
    // Scans on their terminal's wall clock, none in the future.
    expect(result.events.every((event) => event.provider_code && event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.DANX_UNKNOWN_NUMBER)('reads an unknown barcode as not found', async () => {
    await expect(direct().track({ number: process.env.DANX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another code is given.
const NUMBER = process.env.SPEDIRE_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Spedire live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'spedire' });
    expect(answer).toMatchObject({ carrier: 'spedire', source: 'spedire' });
    expect(answer.attempts[0]).toMatchObject({ source: 'spedire', kind: 'ok' });
    const { result } = answer;
    expect(result.provider_code).toMatch(/^[A-Z]$/);
    // Rows on the Italian wall clock, none in the future.
    expect(result.events.every((event) => event.description && event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.SPEDIRE_UNKNOWN_NUMBER)('reads an unknown code as not found', async () => {
    await expect(direct().track({ number: process.env.SPEDIRE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

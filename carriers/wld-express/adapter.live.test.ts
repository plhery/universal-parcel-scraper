import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.WLD_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('WLD Express live retrieval', () => {
  it('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'wld-express' });
    expect(answer).toMatchObject({ carrier: 'wld-express', source: 'wld-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'wld-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock to the second and its code.
    expect(result.events.every((event) => event.description && /^[A-Z]{1,12}$/.test(String(event.provider_code))
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    if (!process.env.WLD_EXPRESS_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'returned', destination_country: 'HU', delivery_tracking_number: expect.any(String) });
    }
  }, 45_000);

  it('reads a number the tracker does not hold as not found', async () => {
    await expect(direct().track({ number: process.env.WLD_EXPRESS_UNKNOWN_NUMBER ?? 'WLDME9999999901' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

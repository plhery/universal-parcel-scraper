import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.URAL_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Ural Express live retrieval', () => {
  it('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'ural-express' });
    expect(answer).toMatchObject({ carrier: 'ural-express', source: 'ural-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ural-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Every row keeps its wall clock to the second and its wording.
    expect(result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    if (!process.env.URAL_EXPRESS_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', destination_country: 'RU' });
      // Its 22 rows, less the package details received again half a minute later, which the facade reads once.
      expect(result.events).toHaveLength(21);
    }
  }, 45_000);

  it('keeps a number Ural Express does not list inconclusive', async () => {
    await expect(direct().track({ number: process.env.URAL_EXPRESS_UNKNOWN_NUMBER ?? 'URA99999999ZPRU' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 45_000);
});

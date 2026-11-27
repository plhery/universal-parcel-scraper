import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public samples, unless another reference is given; the one with a hyphen checks that the hyphen reaches the tracker.
const NUMBERS = process.env.IQFULFILLMENT_TRACKING_NUMBER ? [process.env.IQFULFILLMENT_TRACKING_NUMBER]
  : [numbers.records[0]!.number, numbers.records.find((record) => record.number.includes('-'))!.number];
const UNKNOWN = process.env.IQFULFILLMENT_UNKNOWN_NUMBER;

describe('IQ Fulfillment live retrieval', () => {
  it.each(NUMBERS)('retrieves %s with providers disabled', async (number) => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'iqfulfillment' });
    expect(answer).toMatchObject({ carrier: 'iqfulfillment', source: 'iqfulfillment' });
    expect(answer.attempts[0]).toMatchObject({ source: 'iqfulfillment', kind: 'ok' });
    const { result } = answer;
    expect(result.current_stage).toBeTruthy();
    // Milestones at their instants, none ahead of the read.
    const now = new Date().toISOString();
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.time && event.time <= now)).toBe(true);
  }, 45_000);

  it.skipIf(!UNKNOWN)('reads a reference the tracker holds no order under as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.LEXSHIP_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('LEXSHIP live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'lexship' });
    expect(answer).toMatchObject({ carrier: 'lexship', source: 'lexship' });
    expect(answer.attempts[0]).toMatchObject({ source: 'lexship', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.local_time && event.description)).toBe(true);
    if (!process.env.LEXSHIP_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', destination_country: 'BY' });
    }
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.LEXSHIP_UNKNOWN_NUMBER ?? 'LX1234567890' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another PRO number is given.
const NUMBER = process.env.NUMARK_TRANSPORTATION_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('NuMark Transportation live retrieval', () => {
  it('retrieves the requested PRO number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'numark-transportation' });
    expect(answer).toMatchObject({ carrier: 'numark-transportation', source: 'numark-transportation' });
    expect(answer.attempts[0]).toMatchObject({ source: 'numark-transportation', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Days, or a day and the driver's clock, never an instant the trace does not give.
    expect(events.every((event) => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/.test(event.local_time ?? ''))).toBe(true);
  }, 30_000);

  it('reads an unknown PRO number as not found', async () => {
    await expect(direct().track({ number: process.env.NUMARK_TRANSPORTATION_UNKNOWN_NUMBER ?? '999999990' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

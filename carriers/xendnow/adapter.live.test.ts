import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracking page's example box, unless another is given.
const NUMBER = process.env.XENDNOW_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('XendNow live retrieval', () => {
  it('retrieves the requested box with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'xendnow' });
    expect(answer).toMatchObject({ carrier: 'xendnow', source: 'xendnow' });
    expect(answer.attempts[0]).toMatchObject({ source: 'xendnow', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Coded wordings on a wall clock, none in the future.
    expect(result.events.every((event) => /^\d{1,3}$/.test(String(event.provider_code)) && event.description
      && event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it('reads an unknown box as not found', async () => {
    const unknown = process.env.XENDNOW_UNKNOWN_NUMBER ?? 'EX03991231ZZ9999';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.XINGYUNYI_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('XingYunYi live retrieval', () => {
  it('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'xingyunyi' });
    expect(answer).toMatchObject({ carrier: 'xingyunyi', source: 'xingyunyi' });
    expect(answer.attempts[0]).toMatchObject({ source: 'xingyunyi', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wall clock to the second, its wording and its code.
    expect(result.events.every((event) => event.description && /^\d+$/.test(String(event.provider_code))
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    if (!process.env.XINGYUNYI_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'in_transit', destination_country: 'GB' });
      expect(result.events).toHaveLength(7);
    }
  }, 45_000);

  it('reads a number XingYunYi holds no order for as not found', async () => {
    await expect(direct().track({ number: process.env.XINGYUNYI_UNKNOWN_NUMBER ?? 'XYYEX9999999990YQ' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

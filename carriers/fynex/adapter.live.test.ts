import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.FYNEX_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('FyNEX live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'fynex' });
    expect(answer).toMatchObject({ carrier: 'fynex', source: 'fynex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fynex', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every scan keeps its wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.FYNEX_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Shipment Delivered', destination_country: 'AE' });
      expect(result.events).toHaveLength(3);
    }
  }, 60_000);

  it('leaves a number the tracker shows nothing for open', async () => {
    await expect(direct().track({ number: process.env.FYNEX_UNKNOWN_NUMBER ?? '9999991' })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 60_000);
});

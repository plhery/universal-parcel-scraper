import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.AQX_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('AQX Logistics live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'aqx-logistics' });
    expect(answer).toMatchObject({ carrier: 'aqx-logistics', source: 'aqx-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'aqx-logistics', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    for (const event of result.events) expect(event.time).toEqual(expect.any(String));
    if (!process.env.AQX_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', destination_country: 'SA' });
      expect(result.events.length).toBeGreaterThan(0);
    }
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.AQX_UNKNOWN_NUMBER ?? 'HF-00000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.FLIPXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Flip Xpress live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'flipxpress' });
    expect(answer).toMatchObject({ carrier: 'flipxpress', source: 'flipxpress' });
    expect(answer.attempts[0]).toMatchObject({ source: 'flipxpress', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    for (const event of result.events) expect(event.time).toEqual(expect.any(String));
    if (!process.env.FLIPXPRESS_TRACKING_NUMBER) expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered - Normal' });
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.FLIPXPRESS_UNKNOWN_NUMBER ?? 'TL209901-000001' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

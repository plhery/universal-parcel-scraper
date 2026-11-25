import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.FOUR_A_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('4A Express live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: '4a-express' });
    expect(answer).toMatchObject({ carrier: '4a-express', source: '4a-express' });
    expect(answer.attempts[0]).toMatchObject({ source: '4a-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // The stations' wall clocks, without an offset.
    for (const event of result.events) expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))).toBe(true);
    if (!process.env.FOUR_A_EXPRESS_TRACKING_NUMBER) expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'SHIPMENT DELIVERED' });
  }, 45_000);

  it('keeps the empty answer for an unknown number open', async () => {
    await expect(direct().track({ number: process.env.FOUR_A_EXPRESS_UNKNOWN_NUMBER ?? '010700000999' })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 45_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.RXO_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('RXO live retrieval', () => {
  it('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'rxo' });
    expect(answer).toMatchObject({ carrier: 'rxo', source: 'rxo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'rxo', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    expect(result.events.length).toBeGreaterThan(0);
    // Every event keeps the hub's wall clock or an instant with its offset.
    for (const event of result.events) expect(event.local_time ?? event.time).toEqual(expect.any(String));
    if (!process.env.RXO_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivery completed', sender_name: 'Samsung' });
    }
  }, 90_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.RXO_UNKNOWN_NUMBER ?? 'RXONC70OZZZZZZZZ26' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 90_000);
});

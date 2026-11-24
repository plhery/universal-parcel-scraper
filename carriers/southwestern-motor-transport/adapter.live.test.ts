import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.SOUTHWESTERN_MOTOR_TRANSPORT_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Southwestern Motor Transport live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'southwestern-motor-transport' });
    expect(answer).toMatchObject({ carrier: 'southwestern-motor-transport', source: 'southwestern-motor-transport' });
    expect(answer.attempts[0]).toMatchObject({ source: 'southwestern-motor-transport', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every row keeps its wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.SOUTHWESTERN_MOTOR_TRANSPORT_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
      expect(result.events.at(-1)).toMatchObject({ description: 'Pickup', location: 'HOUSTON, TX' });
    }
  }, 60_000);

  it('reads the empty screen of an invented PRO as inconclusive', async () => {
    await expect(direct().track({ number: '999999998' })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 60_000);
});

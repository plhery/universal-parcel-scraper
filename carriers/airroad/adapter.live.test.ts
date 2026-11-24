import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.AIRROAD_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('AirRoad live retrieval', () => {
  it('retrieves the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'airroad' });
    expect(answer).toMatchObject({ carrier: 'airroad', source: 'airroad' });
    expect(answer.attempts[0]).toMatchObject({ source: 'airroad', kind: 'ok' });
    const { result } = answer;
    // The current status alone, on a wall clock without an offset.
    expect(result.events).toHaveLength(1);
    expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(result.events[0]!.local_time))).toBe(true);
    if (!process.env.AIRROAD_TRACKING_NUMBER) expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered' });
  }, 45_000);

  it('reads a number the lookup does not know as not found', async () => {
    await expect(direct().track({ number: process.env.AIRROAD_UNKNOWN_NUMBER ?? 'GFL9999999' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

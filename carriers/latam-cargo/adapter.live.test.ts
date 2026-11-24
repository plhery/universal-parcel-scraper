import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.LATAM_CARGO_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('LATAM Cargo live retrieval', () => {
  it('retrieves the requested document with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'latam-cargo' });
    expect(answer).toMatchObject({ carrier: 'latam-cargo', source: 'latam-cargo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'latam-cargo', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Station wall clocks without an offset.
    expect(result.events.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    if (!process.env.LATAM_CARGO_TRACKING_NUMBER) expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Shipment Delivered' });
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.LATAM_CARGO_UNKNOWN_NUMBER ?? '957-00000011' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

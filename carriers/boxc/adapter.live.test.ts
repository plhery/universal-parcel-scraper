import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.BOXC_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('BoxC live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'boxc' });
    expect(answer).toMatchObject({ carrier: 'boxc', source: 'boxc' });
    expect(answer.attempts[0]).toMatchObject({ source: 'boxc', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every event keeps the scan's wall clock or an instant with its offset.
    for (const event of result.events) expect(event.local_time ?? event.time).toEqual(expect.any(String));
    if (!process.env.BOXC_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Delivered', service_name: 'BoxC Parcel', destination_country: 'CA' });
    }
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.BOXC_UNKNOWN_NUMBER ?? 'BOXC00000000999' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

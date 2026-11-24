import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another number is given.
const NUMBER = process.env.COMONE_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('ComOne Express live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'comone-express' });
    expect(answer).toMatchObject({ carrier: 'comone-express', source: 'comone-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'comone-express', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every scan keeps its wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.COMONE_EXPRESS_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Shipment Delivered', destination_country: 'SG' });
      expect(result.events.length).toBeGreaterThan(10);
    }
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.COMONE_EXPRESS_UNKNOWN_NUMBER ?? 'CM9900000017' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

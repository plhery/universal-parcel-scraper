import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.TOP_LOGISTICS_AU_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Top Logistics Australia live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'top-logistics-au' });
    expect(answer).toMatchObject({ carrier: 'top-logistics-au', source: 'top-logistics-au' });
    expect(answer.attempts[0]).toMatchObject({ source: 'top-logistics-au', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(1);
    // Wall clocks to the minute, or a day alone for a scan without a time.
    for (const event of result.events) expect(String(event.local_time)).toMatch(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:00)?$/);
    if (!process.env.TOP_LOGISTICS_AU_TRACKING_NUMBER) expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'DELIVERED' });
  }, 45_000);

  it('leaves a number the frame does not know open', async () => {
    await expect(direct().track({ number: process.env.TOP_LOGISTICS_AU_UNKNOWN_NUMBER ?? 'TPL000000000' })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 45_000);
});

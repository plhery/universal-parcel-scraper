import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another consignment number is given.
const NUMBER = process.env.BOOTHS_LOGISTICS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Booth\'s Logistics live retrieval', () => {
  it('retrieves the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'booths-logistics' });
    expect(answer).toMatchObject({ carrier: 'booths-logistics', source: 'booths-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'booths-logistics', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toBeTruthy();
    expect(result.events.length).toBeGreaterThan(0);
    // Milestones on New Zealand's clock, none in the future.
    expect(result.events.every((event) => event.provider_code && (event.time ?? event.local_time)
      && Date.parse(event.time ?? `${event.local_time}Z`) <= Date.now() + 14 * 3_600_000)).toBe(true);
  });

  it.skipIf(!process.env.BOOTHS_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown consignment number as not found', async () => {
    await expect(direct().track({ number: process.env.BOOTHS_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

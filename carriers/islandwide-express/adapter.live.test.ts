import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.ISLANDWIDE_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Islandwide Express live retrieval', () => {
  it('retrieves the requested shipment and its history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'islandwide-express' });
    expect(answer).toMatchObject({ carrier: 'islandwide-express', source: 'islandwide-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'islandwide-express', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Wall clocks to the second, dated on Puerto Rico's clock, none in the future.
    expect(events.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && event.time_zone === 'America/Puerto_Rico' && event.time && Date.parse(event.time) <= Date.now() && event.description)).toBe(true);
  }, 45_000);

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ISLANDWIDE_EXPRESS_UNKNOWN_NUMBER ?? '999000999QZQZQZ9990009' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

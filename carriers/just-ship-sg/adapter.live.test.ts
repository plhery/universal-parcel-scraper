import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another shipping ID is given.
const NUMBER = process.env.JUST_SHIP_SG_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('JustShip live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'just-ship-sg' });
    expect(answer).toMatchObject({ carrier: 'just-ship-sg', source: 'just-ship-sg' });
    expect(answer.attempts[0]).toMatchObject({ source: 'just-ship-sg', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Scans on their instants, none in the future.
    expect(result.events.every((event) => event.provider_code && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.JUST_SHIP_SG_UNKNOWN_NUMBER)('reads an unknown shipping ID as not found', async () => {
    await expect(direct().track({ number: process.env.JUST_SHIP_SG_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another shipment id is given.
const NUMBER = process.env.AIRMEE_TRACKING_NUMBER ?? numbers.records[0]!.number;
// A synthetic id of the Amazon shape, unless another is given.
const UNKNOWN = process.env.AIRMEE_UNKNOWN_NUMBER ?? 'AM000000000';

describe('Airmee live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'airmee' });
    expect(answer).toMatchObject({ carrier: 'airmee', source: 'airmee' });
    expect(answer.attempts[0]).toMatchObject({ source: 'airmee', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows with their code and an instant, none in the future.
    expect(result.events.every((event) => event.provider_code && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads an unknown shipment id as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

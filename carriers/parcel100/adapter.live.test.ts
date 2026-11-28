import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.PARCEL100_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Parcel100 live retrieval', () => {
  it('retrieves the parcel history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'parcel100' });
    expect(answer).toMatchObject({ carrier: 'parcel100', source: 'parcel100' });
    expect(answer.attempts[0]).toMatchObject({ source: 'parcel100', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 30_000);

  it('reads an unknown parcel number as not found', async () => {
    const unknown = process.env.PARCEL100_UNKNOWN_NUMBER ?? 'PK00099999';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

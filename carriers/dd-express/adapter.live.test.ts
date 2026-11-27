import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.DD_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('DD Express live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'dd-express' });
    expect(answer).toMatchObject({ carrier: 'dd-express', source: 'dd-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dd-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Statuses are instants the tracker states.
    expect(result.events.every((event) => /(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)) && !event.local_time)).toBe(true);
  });

  it.skipIf(!process.env.DD_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.DD_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

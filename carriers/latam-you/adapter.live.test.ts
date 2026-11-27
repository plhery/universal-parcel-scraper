import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBERS = process.env.LATAM_YOU_TRACKING_NUMBER
  ? [process.env.LATAM_YOU_TRACKING_NUMBER] : numbers.records.map((record) => record.number);

describe('Latam You live retrieval', () => {
  it.each(NUMBERS)('retrieves the requested order with providers disabled', async (number) => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'latam-you' });
    expect(answer).toMatchObject({ carrier: 'latam-you', source: 'latam-you' });
    expect(answer.attempts[0]).toMatchObject({ source: 'latam-you', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows as instants with the offset the service states, none in the future.
    expect(result.events.every((event) => event.description && event.time && /[+-]\d{2}:\d{2}$/.test(event.time)
      && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it.skipIf(!process.env.LATAM_YOU_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.LATAM_YOU_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

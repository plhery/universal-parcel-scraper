import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public samples the tracker holds a job under, unless another number is given.
const NUMBERS = process.env.FST_EXPRESS_TRACKING_NUMBER
  ? [process.env.FST_EXPRESS_TRACKING_NUMBER]
  : numbers.records.filter((record) => record.context.assessment === 'confirmed').map((record) => record.number);

describe('FST Express live retrieval', () => {
  it.each(NUMBERS)('retrieves the requested job with providers disabled', async (number) => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'fst-express' });
    expect(answer).toMatchObject({ carrier: 'fst-express', source: 'fst-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'fst-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Scans as instants with their offset, none in the future.
    expect(result.events.every((event) => event.description && event.time && /[+-]\d{2}:\d{2}$/.test(event.time)
      && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads the commented example in the tracker page’s script as not found', async () => {
    const example = numbers.records.find((record) => record.context.assessment === 'candidate')!.number;
    await expect(direct().track({ number: example })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it.skipIf(!process.env.FST_EXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.FST_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

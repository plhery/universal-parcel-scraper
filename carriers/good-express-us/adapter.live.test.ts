import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given. The tracker forgets a waybill some months after its delivery.
const NUMBER = process.env.GOOD_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('GOOD Express live retrieval', () => {
  it('retrieves the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'good-express-us' });
    expect(answer).toMatchObject({ carrier: 'good-express-us', source: 'good-express-us' });
    expect(answer.attempts[0]).toMatchObject({ source: 'good-express-us', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Every row is an instant on China time, none after the lookup.
    expect(result.events.every((event) => event.description && event.time?.endsWith('+08:00') && Date.parse(event.time) <= Date.now())).toBe(true);
    expect(result.last_update).toBe(result.events[0]!.time);
  }, 45_000);

  it.skipIf(!process.env.GOOD_EXPRESS_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.GOOD_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

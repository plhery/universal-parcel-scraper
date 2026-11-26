import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another waybill is given.
const NUMBER = process.env.UNICON_EXPRESS_US_TRACKING_NUMBER ?? numbers.records[0]!.number;

// China keeps UTC+08:00 all year, so its wall clock now is eight hours ahead of UTC.
const chinaNow = () => new Date(Date.now() + 8 * 3_600_000).toISOString();

describe('UNICON Express USA live retrieval', () => {
  it('retrieves the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'unicon-express-us' });
    expect(answer).toMatchObject({ carrier: 'unicon-express-us', source: 'unicon-express-us' });
    expect(answer.attempts[0]).toMatchObject({ source: 'unicon-express-us', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Wordings on a wall clock, none in the future, and no phone number left in them.
    expect(result.events.every((event) => event.description && event.local_time && event.local_time <= chinaNow()
      && !/\d{7,}/.test(event.description.replace(/单号为\s*[A-Z]*\d+/, '')))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.UNICON_EXPRESS_US_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.UNICON_EXPRESS_US_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

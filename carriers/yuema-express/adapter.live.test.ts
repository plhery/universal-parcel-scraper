import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another waybill is given.
const NUMBER = process.env.YUEMA_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Yuema Express live retrieval', () => {
  it('retrieves the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'yuema-express' });
    expect(answer).toMatchObject({ carrier: 'yuema-express', source: 'yuema-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'yuema-express', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Every row has its code and its wall clock read on China's clock, none in the future.
    expect(events.every((event) => event.provider_code && event.time_zone === 'Asia/Shanghai'
      && event.time === `${event.local_time}+08:00` && Date.parse(event.time) <= Date.now())).toBe(true);
    // No courier's mobile number is left in the wording; the courier's twelve-digit waybill stays.
    expect(events.some((event) => /(?<!\d)1[3-9]\d{9}(?!\d)/.test(event.description ?? ''))).toBe(false);
  });

  it.skipIf(!process.env.YUEMA_EXPRESS_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.YUEMA_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another consignment note is given.
const NUMBER = process.env.ATC_LOGISTICAL_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('ATC Logistical Solutions live retrieval', () => {
  it('retrieves the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'atc-logistical' });
    expect(answer).toMatchObject({ carrier: 'atc-logistical', source: 'atc-logistical' });
    expect(answer.attempts[0]).toMatchObject({ source: 'atc-logistical', kind: 'ok' });
    const { result } = answer;
    expect(result.provider_code).toMatch(/^[A-Z][A-Z ]{2,30}$/);
    // Milestones on the tracker's dates, the booking among them, none in the future.
    expect(result.events.some((event) => event.provider_code === 'BOOKED')).toBe(true);
    expect(result.events.every((event) => event.provider_code && event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it('reads an unknown consignment note as not found', async () => {
    await expect(direct().track({ number: process.env.ATC_LOGISTICAL_UNKNOWN_NUMBER ?? '98765432' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

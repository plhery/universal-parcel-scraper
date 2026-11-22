import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given. The tracker keeps a year of shipments.
const NUMBER = process.env.CORETRAILS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Coretrails live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'coretrails' });
    expect(answer).toMatchObject({ carrier: 'coretrails', source: 'coretrails' });
    expect(answer.attempts[0]).toMatchObject({ source: 'coretrails', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Scans on their place's wall clock, none in the future.
    expect(result.events.every((event) => event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.CORETRAILS_UNKNOWN_NUMBER ?? 'CRT000000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

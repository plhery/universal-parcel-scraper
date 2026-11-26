import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public samples, unless another number is given.
const NUMBERS = process.env.NEXT_SMART_SHIP_TRACKING_NUMBER
  ? [process.env.NEXT_SMART_SHIP_TRACKING_NUMBER] : numbers.records.map((record) => record.number);

describe('Next Smart Ship live retrieval', () => {
  it.each(NUMBERS)('retrieves the requested parcel with providers disabled', async (number) => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'next-smart-ship' });
    expect(answer).toMatchObject({ carrier: 'next-smart-ship', source: 'next-smart-ship' });
    expect(answer.attempts[0]).toMatchObject({ source: 'next-smart-ship', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Scans as instants, none in the future.
    expect(result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
    expect(result.delivery_tracking_number).toMatch(/^[A-Z0-9]{4,40}$/);
  });

  it.skipIf(!process.env.NEXT_SMART_SHIP_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.NEXT_SMART_SHIP_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

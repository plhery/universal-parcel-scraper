import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { EcparcelTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

// The public sample, unless another number is given.
const NUMBERS = process.env.ECPARCEL_TRACKING_NUMBER
  ? [process.env.ECPARCEL_TRACKING_NUMBER] : numbers.records.map((record) => record.number);
// A synthetic number of the sample's shape, dated in 2099.
const UNKNOWN = process.env.ECPARCEL_UNKNOWN_NUMBER ?? 'YOTN20991231900000017';

describe('ecParcel live retrieval', () => {
  it.each(NUMBERS)('retrieves the requested shipment with providers disabled', async (number) => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'ecparcel' });
    expect(answer).toMatchObject({ carrier: 'ecparcel', source: 'ecparcel' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ecparcel', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Scans as instants with the offset or Z the service states, none in the future.
    expect(result.events.every((event) => event.description && event.time && /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time)
      && Date.parse(event.time) <= Date.now())).toBe(true);
  }, 20_000);

  it('reads an unknown number as not found', async () => {
    await expect(new EcparcelTracker().fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
  }, 20_000);
});

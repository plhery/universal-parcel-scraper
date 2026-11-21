import { describe, expect, it } from 'vitest';
import { createTracker } from '../../facade/index.js';
import { DragonflyNlTracker } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

// The newest public sample, unless another number is given. The service keeps a parcel for a few months.
const NUMBER = process.env.DRAGONFLY_NL_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Dragonfly Netherlands live retrieval', () => {
  it('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'dragonfly-nl' });
    expect(answer).toMatchObject({ carrier: 'dragonfly-nl', source: 'dragonfly-nl' });
    expect(answer.attempts[0]).toMatchObject({ source: 'dragonfly-nl', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.provider_code && event.time)).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(new DragonflyNlTracker().fetch(process.env.DRAGONFLY_NL_UNKNOWN_NUMBER ?? 'AMZNL999999999999'))
      .rejects.toMatchObject({ kind: 'not_found' });
  });
});

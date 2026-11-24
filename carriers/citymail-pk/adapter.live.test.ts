import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another consignment number is given.
const NUMBER = process.env.CITYMAIL_PK_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('CityMail Pakistan live retrieval', () => {
  it('retrieves the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'citymail-pk' });
    expect(answer).toMatchObject({ carrier: 'citymail-pk', source: 'citymail-pk' });
    expect(answer.attempts[0]).toMatchObject({ source: 'citymail-pk', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows on a wall clock without an offset, none in the future, each with its status as its code.
    expect(result.events.every((event) => event.provider_code && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))
      && String(event.local_time) <= new Date().toISOString())).toBe(true);
  }, 45_000);

  it('reads a number CityMail does not know as not found', async () => {
    await expect(direct().track({ number: process.env.CITYMAIL_PK_UNKNOWN_NUMBER ?? '987654321' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

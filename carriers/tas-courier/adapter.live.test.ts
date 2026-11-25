import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another voucher is given.
const NUMBER = process.env.TAS_COURIER_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('TAS Courier live retrieval', () => {
  it('retrieves the requested voucher with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'tas-courier' });
    expect(answer).toMatchObject({ carrier: 'tas-courier', source: 'tas-courier' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tas-courier', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Every status keeps the Athens wall clock without an offset.
    for (const event of result.events) expect(event).toMatchObject({ local_time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/) });
    if (!process.env.TAS_COURIER_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Έγινε Παράδοση Στον Παραλήπτη', last_update_local: '2022-07-18T14:30:00' });
    }
  }, 45_000);

  it('reads a voucher the search does not find as inconclusive', async () => {
    await expect(direct().track({ number: process.env.TAS_COURIER_UNKNOWN_NUMBER ?? 'V-99999990' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 45_000);
});

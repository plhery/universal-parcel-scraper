import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another barcode is given.
const NUMBER = process.env.CODEXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('CODExpress live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'codexpress' });
    expect(answer).toMatchObject({ carrier: 'codexpress', source: 'codexpress' });
    expect(answer.attempts[0]).toMatchObject({ source: 'codexpress', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Statuses on a wall clock without an offset, each with Locate2u's status as its code.
    expect(result.events.every((event) => event.provider_code && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(result.events.some((event) => event.stage_source === 'carrier_map')).toBe(true);
  }, 45_000);

  it('reads a barcode the account does not hold as not found', async () => {
    await expect(direct().track({ number: process.env.CODEXPRESS_UNKNOWN_NUMBER ?? 'CODE999999999' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

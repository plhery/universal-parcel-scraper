import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const number = process.env.ACPL_CARGO_TRACKING_NUMBER ?? numbers.records[0]!.number;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ACPL Cargo live retrieval', () => {
  it('retrieves the movements of the requested GC with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'acpl-cargo' });
    expect(answer).toMatchObject({ carrier: 'acpl-cargo', source: 'acpl-cargo' });
    expect(answer.attempts[0]).toMatchObject({ source: 'acpl-cargo', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.time?.endsWith('+05:30') && event.time_zone_basis === 'carrier')).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.ACPL_CARGO_UNKNOWN_NUMBER)('reads an unknown GC number as not found', async () => {
    await expect(direct().track({ number: process.env.ACPL_CARGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

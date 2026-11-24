import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const number = process.env.CTL_GROUP_PL_TRACKING_NUMBER ?? numbers.records[0]!.number;
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CTL Group live retrieval', () => {
  it('retrieves the scans of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'ctl-group-pl' });
    expect(answer).toMatchObject({ carrier: 'ctl-group-pl', source: 'ctl-group-pl' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ctl-group-pl', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.CTL_GROUP_PL_UNKNOWN_NUMBER)('reads an unknown waybill number as not found', async () => {
    await expect(direct().track({ number: process.env.CTL_GROUP_PL_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

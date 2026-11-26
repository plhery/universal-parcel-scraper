import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another consignment is given.
const NUMBER = process.env.SPC_WORLDWIDE_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('SPC Worldwide Express live retrieval', () => {
  it('retrieves the requested consignment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'spc-worldwide-express' });
    expect(answer).toMatchObject({ carrier: 'spc-worldwide-express', source: 'spc-worldwide-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'spc-worldwide-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Status codes on the station's wall clock, none in the future.
    expect(result.events.every((event) => /^[A-Z][A-Z0-9_]+$/.test(String(event.provider_code))
      && event.local_time && event.local_time <= new Date().toISOString())).toBe(true);
  });

  it.skipIf(!process.env.SPC_WORLDWIDE_EXPRESS_UNKNOWN_NUMBER)('reads an unknown consignment as not found', async () => {
    await expect(direct().track({ number: process.env.SPC_WORLDWIDE_EXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { XINDUS_TRACKING_NUMBER: found, XINDUS_UNKNOWN_NUMBER: unknown } = process.env;

describe('Xindus live retrieval', () => {
  it.skipIf(!found)('retrieves the history of the requested air waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: found!, carrier: 'xindus' });
    expect(answer).toMatchObject({ carrier: 'xindus', source: 'xindus' });
    expect(answer.attempts[0]).toMatchObject({ source: 'xindus', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan carries the zone Xindus states for it.
    expect(answer.result.events.every((event) => /[+-]\d{2}:\d{2}$/.test(String(event.time)))).toBe(true);
    expect(answer.result.events.every((event) => event.description && event.provider_code)).toBe(true);
  }, 45_000);

  it.skipIf(!unknown)('reads an unknown air waybill as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

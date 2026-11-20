import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Air Inuit live retrieval', () => {
  it.skipIf(!process.env.AIR_INUIT_TRACKING_NUMBER)('retrieves the waybill history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.AIR_INUIT_TRACKING_NUMBER!, carrier: 'air-inuit' });
    expect(answer).toMatchObject({ carrier: 'air-inuit', source: 'air-inuit' });
    expect(answer.attempts[0]).toMatchObject({ source: 'air-inuit', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    expect(answer.result.events.some((event) => event.stage)).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.AIR_INUIT_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.AIR_INUIT_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

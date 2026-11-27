import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('BlueGrace Logistics live retrieval', () => {
  it.skipIf(!process.env.BLUEGRACE_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.BLUEGRACE_LOGISTICS_TRACKING_NUMBER!, carrier: 'bluegrace-logistics' });
    expect(answer).toMatchObject({ carrier: 'bluegrace-logistics', source: 'bluegrace-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bluegrace-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps its wall clock to the second and its X12 214 code.
    expect(answer.result.events.every((event) => event.description && /^[A-Z0-9]{2}$/.test(String(event.provider_code))
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.BLUEGRACE_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.BLUEGRACE_LOGISTICS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

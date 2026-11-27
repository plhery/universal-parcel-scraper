import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The tracker's search no longer finds the public sample, so a found number comes from outside the repository.
const positive = process.env.IFLOW_TRACKING_NUMBER;
// The all-zero code: the registry refuses it as a placeholder, so it goes to the adapter itself.
const UNKNOWN = 'TRI0000000000000';

describe('iFLOW live retrieval', () => {
  it.skipIf(!positive)('retrieves the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: positive!, carrier: 'iflow' });
    expect(answer).toMatchObject({ carrier: 'iflow', source: 'iflow' });
    expect(answer.attempts[0]).toMatchObject({ source: 'iflow', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Instants on Argentina's clock, none in the future.
    expect(events.every((event) => event.description && event.provider_code && event.time?.endsWith('-03:00')
      && Date.parse(event.time) <= Date.now())).toBe(true);
  }, 45_000);

  it('reads the search’s server error for an unknown code as no record shown', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 30_000);
});

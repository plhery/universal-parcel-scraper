import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Zhongzhou Logistics live retrieval', () => {
  it.skipIf(!process.env.ZHONGZHOU_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] })
      .track({ number: process.env.ZHONGZHOU_LOGISTICS_TRACKING_NUMBER!, carrier: 'zhongzhou-logistics' });
    expect(answer).toMatchObject({ carrier: 'zhongzhou-logistics', source: 'zhongzhou-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'zhongzhou-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every row keeps its wall clock: the record does not say which zone a row abroad is on.
    expect(answer.result.events.every((event) => event.description
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.ZHONGZHOU_LOGISTICS_UNKNOWN_NUMBER ?? 'ZZ9999999999CN' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

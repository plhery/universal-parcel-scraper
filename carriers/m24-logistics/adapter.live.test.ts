import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { M24_LOGISTICS_TRACKING_NUMBER: found, M24_LOGISTICS_UNKNOWN_NUMBER: unknown } = process.env;

describe('M24 Logistics live retrieval', () => {
  it.skipIf(!found)('retrieves the history of the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: found!, carrier: 'm24-logistics' });
    expect(answer).toMatchObject({ carrier: 'm24-logistics', source: 'm24-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'm24-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.provider_code && /\+02:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!unknown)('fails an unknown reference without reading it as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
  }, 30_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const { WANGJING_3CQ_TRACKING_NUMBER: found, WANGJING_3CQ_UNKNOWN_NUMBER: unknown } = process.env;

describe('Wangjing 3CQ live retrieval', () => {
  it.skipIf(!found)('retrieves the history of the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: found!, carrier: 'wangjing-3cq' });
    expect(answer).toMatchObject({ carrier: 'wangjing-3cq', source: 'wangjing-3cq' });
    expect(answer.attempts[0]).toMatchObject({ source: 'wangjing-3cq', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan carries the offset 3CQ states for it.
    expect(answer.result.events.every((event) => /[+-]\d{2}:\d{2}$/.test(String(event.time)) && event.description)).toBe(true);
  }, 45_000);

  it.skipIf(!unknown)('reads a number with no history as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

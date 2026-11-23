import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

describe('Seaboard Marine live retrieval', () => {
  it.skipIf(!process.env.SEABOARD_MARINE_TRACKING_NUMBER)('retrieves the requested container\'s last move with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.SEABOARD_MARINE_TRACKING_NUMBER!, carrier: 'seaboard-marine' });
    expect(answer).toMatchObject({ carrier: 'seaboard-marine', source: 'seaboard-marine', attempts: [{ source: 'seaboard-marine', kind: 'ok' }] });
    expect(answer.result).toMatchObject({ history_truncated: true });
    expect(answer.result.events).toHaveLength(1);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.SEABOARD_MARINE_UNKNOWN_NUMBER)('reads a container the tracker holds no record of as its empty answer', async () => {
    await expect(adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null })
      .track({ number: process.env.SEABOARD_MARINE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 75_000);
});

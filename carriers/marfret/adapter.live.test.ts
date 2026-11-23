import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

describe('Marfret live retrieval', () => {
  it.skipIf(!process.env.MARFRET_TRACKING_NUMBER)('retrieves dated moves for the requested container with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.MARFRET_TRACKING_NUMBER!, carrier: 'marfret' });
    expect(answer).toMatchObject({ carrier: 'marfret', source: 'marfret', attempts: [{ source: 'marfret', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time)).toBe(true);
  }, 75_000);

  it.skipIf(!process.env.MARFRET_UNKNOWN_NUMBER)('reads an unknown container as not found', async () => {
    await expect(adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null })
      .track({ number: process.env.MARFRET_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});

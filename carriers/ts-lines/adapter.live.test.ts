import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

describe('T.S. Lines live retrieval', () => {
  it.skipIf(!process.env.TS_LINES_TRACKING_NUMBER)('retrieves dated moves for the requested container or bill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.TS_LINES_TRACKING_NUMBER!, carrier: 'ts-lines' });
    expect(answer).toMatchObject({ carrier: 'ts-lines', source: 'ts-lines', attempts: [{ source: 'ts-lines', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && event.local_time && !event.time)).toBe(true);
  }, 75_000);

  // Called directly: a placeholder-shaped unknown bill is refused before any request by the facade.
  it.skipIf(!process.env.TS_LINES_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null })
      .track({ number: process.env.TS_LINES_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 75_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('LibanPost live guest retrieval', () => {
  it.skipIf(!process.env.LIBANPOST_TRACKING_NUMBER)('retrieves the requested history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.LIBANPOST_TRACKING_NUMBER!, carrier: 'libanpost' });
    expect(answer).toMatchObject({ carrier: 'libanpost', source: 'libanpost', attempts: [{ source: 'libanpost', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every(event => event.local_time && event.description && !event.time)).toBe(true);
    expect(JSON.stringify(answer.result)).not.toMatch(/Signed\s*:/i);
  }, 30_000);

  it.skipIf(!process.env.LIBANPOST_UNKNOWN_NUMBER)('keeps the explicit unknown result', async () => {
    await expect(direct().track({ number: process.env.LIBANPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

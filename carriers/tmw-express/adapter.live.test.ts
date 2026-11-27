import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// No public page shows a TMW Express order number, so both come from outside the repository.
const positive = process.env.TMW_EXPRESS_TRACKING_NUMBER;
const unknown = process.env.TMW_EXPRESS_UNKNOWN_NUMBER;

// No place keeps a clock more than fourteen hours ahead of UTC.
const latestWallClock = () => new Date(Date.now() + 14 * 3_600_000).toISOString();

describe('TMW Express live retrieval', () => {
  it.skipIf(!positive)('retrieves the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: positive!, carrier: 'tmw-express' });
    expect(answer).toMatchObject({ carrier: 'tmw-express', source: 'tmw-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'tmw-express', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.description && event.local_time && event.local_time <= latestWallClock())).toBe(true);
  }, 45_000);

  it.skipIf(!unknown)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

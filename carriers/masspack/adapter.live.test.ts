import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// No public page shows a Masspack order number, so both come from outside the repository.
const positive = process.env.MASSPACK_TRACKING_NUMBER;
const unknown = process.env.MASSPACK_UNKNOWN_NUMBER;

describe('Masspack Express live retrieval', () => {
  it.skipIf(!positive)('retrieves the requested number with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: positive!, carrier: 'masspack' });
    expect(answer).toMatchObject({ carrier: 'masspack', source: 'masspack' });
    expect(answer.attempts[0]).toMatchObject({ source: 'masspack', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now() + 60_000)).toBe(true);
  }, 45_000);

  it.skipIf(!unknown)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

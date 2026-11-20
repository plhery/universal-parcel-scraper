import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const known = process.env.GOLLOG_TRACKING_NUMBER;
const unknown = process.env.GOLLOG_UNKNOWN_NUMBER;

describe('GOLLOG guest tracking', () => {
  it.skipIf(!known)('reads dated events for the waybill', async () => {
    const result = await tracker.track({ number: known! });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.last_update).toEqual(expect.any(String));
  });
  it.skipIf(!unknown)('reports the missing waybill', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

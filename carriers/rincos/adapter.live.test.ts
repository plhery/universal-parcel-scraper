import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Rincos live retrieval', () => {
  it.skipIf(!process.env.RINCOS_TRACKING_NUMBER)('reads whole-identifier origin and destination history', async () => {
    const result = await direct().track({ number: process.env.RINCOS_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.local_time)).toBe(true);
    expect(result.last_update_local).toBeTruthy();
  });

  it.skipIf(!process.env.RINCOS_UNKNOWN_NUMBER)('keeps the no-information notice inconclusive', async () => {
    await expect(direct().track({ number: process.env.RINCOS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

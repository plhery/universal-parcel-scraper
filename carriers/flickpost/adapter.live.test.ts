import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Flickpost live retrieval', () => {
  for (const name of ['FLICKPOST_TRACKING_NUMBER', 'FLICKPOST_OWN_NUMBER']) {
    it.skipIf(!process.env[name])(`reads a bound history from ${name}`, async () => {
      const result = await direct().track({ number: process.env[name]! });
      expect(result.events!.length).toBeGreaterThan(0);
      expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
      expect(result.service_name).toBeTruthy();
      expect(result.weight_kg).toBeGreaterThanOrEqual(0);
    });
  }
  it.skipIf(!process.env.FLICKPOST_UNKNOWN_NUMBER)('returns the exact whole-number absence reply', async () => {
    await expect(direct().track({ number: process.env.FLICKPOST_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

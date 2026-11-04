import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Etomars live retrieval', () => {
  it.skipIf(!process.env.ETOMARS_TRACKING_NUMBER)('reads the whole registration and its dated scans', async () => {
    const result = await direct().track({ number: process.env.ETOMARS_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description && event.provider_code)).toBe(true);
    expect(result.destination_country).toBe('JP');
  });

  it.skipIf(!process.env.ETOMARS_UNKNOWN_NUMBER)('keeps absent or expired history inconclusive', async () => {
    await expect(direct().track({ number: process.env.ETOMARS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

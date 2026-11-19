import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';
const number = process.env.CORREOS_COSTA_RICA_TRACKING_NUMBER, unknown = process.env.CORREOS_COSTA_RICA_UNKNOWN_NUMBER;
const url = process.env.FLARESOLVERR_URL;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: url ? new TrawlClient(url) : null });
describe('Correos de Costa Rica live guest history', () => {
  it.skipIf(!number || !url)('returns number-bound dated scans', async () => {
    const result = await tracker().track({ number: number! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(e => e.local_time && e.description && !e.time)).toBe(true);
  }, 80000);
  it.skipIf(!unknown || !url)('keeps the explicit unregistered notice', async () => {
    await expect(tracker().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 80000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';

const number = process.env.JT_BR_TRACKING_NUMBER, unknown = process.env.JT_BR_UNKNOWN_NUMBER;
const url = process.env.FLARESOLVERR_URL;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: url ? new TrawlClient(url) : null });
describe('J&T Brazil live guest retrieval', () => {
  it.skipIf(!number || !url)('reads whole-bound dated history', async () => {
    const result = await tracker().track({ number: number! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.local_time)).toBe(true);
  }, 115000);
  it.skipIf(!unknown || !url)('keeps an empty success as no history', async () => {
    await expect(tracker().track({ number: unknown! })).rejects.toMatchObject({ kind: 'indeterminate', name: 'NoHistoryError' });
  }, 115000);
});

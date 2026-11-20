import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';

const number = process.env.MAGIC_TRANS_TRACKING_NUMBER ?? '021147139';
const url = process.env.FLARESOLVERR_URL;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: url ? new TrawlClient(url) : null });

describe('Magic Trans live tracker', () => {
  it.skipIf(!url)('returns the number’s dated rows', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
  }, 120_000);
  it.skipIf(!url)('reads an impossible act number as not found', async () => {
    await expect(tracker().track({ number: '000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 120_000);
});

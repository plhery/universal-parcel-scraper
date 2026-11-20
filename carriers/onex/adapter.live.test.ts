import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';

const number = process.env.ONEX_TRACKING_NUMBER ?? 'TM800329354AM';
const url = process.env.FLARESOLVERR_URL;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: url ? new TrawlClient(url) : null });

describe('Onex live tracker', () => {
  it.skipIf(!url)('returns the number’s events on their wall clocks', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
  }, 90_000);
  it.skipIf(!url)('reads an unknown number as not found', async () => {
    await expect(tracker().track({ number: 'ZZZZ000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 90_000);
});

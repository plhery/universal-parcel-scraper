import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const number = process.env.TURKON_LINE_TRACKING_NUMBER ?? numbers.records[0]!.number;
const unknown = process.env.TURKON_LINE_UNKNOWN_NUMBER;
const url = process.env.FLARESOLVERR_URL;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: url ? new TrawlClient(url) : null });

describe('Turkon Line live tracker', () => {
  it.skipIf(!url)('returns the containers’ moves on their wall clocks', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description && event.provider_code)).toBe(true);
  }, 120_000);
  it.skipIf(!url || !unknown)('reads an unknown number as not found', async () => {
    await expect(tracker().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 120_000);
});

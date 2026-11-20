import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { TrawlClient } from '../../core/transport/trawl.js';
import { adapter } from './adapter.js';

const number = process.env.GINTRACOM_TRACKING_NUMBER ?? '7000793965';
const unknown = process.env.GINTRACOM_UNKNOWN_NUMBER;
const url = process.env.FLARESOLVERR_URL;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: url ? new TrawlClient(url) : null });

describe('Gintracom live tracker', () => {
  it.skipIf(!url)('returns the guide’s rows at instants in Ecuador', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time?.endsWith('-05:00') && event.description)).toBe(true);
  }, 90_000);
  it.skipIf(!url || !unknown)('reads an unknown guide as not found', async () => {
    await expect(tracker().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 90_000);
});

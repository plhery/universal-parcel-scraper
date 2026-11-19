import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const executablePath = process.env.TRACKING_CHROMIUM_PATH?.trim() || null;
const positive = process.env.TUSK_LOGISTICS_TRACKING_NUMBER;
const unknown = process.env.TUSK_LOGISTICS_UNKNOWN_NUMBER;
const tracker = adapter({ trawl: null, browserExecutablePath: executablePath, recorder: NOOP_RECORDER, env: {} });

describe('Tusk Logistics live retrieval', () => {
  it.skipIf(!positive || !executablePath)('reads the public scan table', async () => {
    expect((await tracker.track({ number: positive! })).events?.length).toBeGreaterThan(0);
  }, 35_000);
  it.skipIf(!unknown || !executablePath)('reports an unknown shipment', async () => {
    await expect(tracker.track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 35_000);
});

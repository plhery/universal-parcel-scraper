import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const number = process.env.SARJAK_TRACKING_NUMBER ?? numbers.records[0]!.number;
const unknown = process.env.SARJAK_UNKNOWN_NUMBER;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('Sarjak Container Lines live tracker', () => {
  it('returns the containers’ milestones by day', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => /^\d{4}-\d{2}-\d{2}$/.test(event.local_time ?? '') && event.description)).toBe(true);
  }, 60_000);
  it.skipIf(!unknown)('reads an unknown number as not found', async () => {
    await expect(tracker().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

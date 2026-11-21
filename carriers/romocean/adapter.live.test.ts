import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const number = process.env.ROMOCEAN_TRACKING_NUMBER ?? numbers.records[0]!.number;
const unknown = process.env.ROMOCEAN_UNKNOWN_NUMBER;
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('Romocean live tracker', () => {
  it('returns the bill’s moves on the ports’ wall clocks', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description && event.provider_code)).toBe(true);
  }, 30_000);
  it.skipIf(!unknown)('reads an unknown number as not found', async () => {
    await expect(tracker().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

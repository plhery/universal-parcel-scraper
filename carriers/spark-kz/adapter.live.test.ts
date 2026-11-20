import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.SPARK_KZ_TRACKING_NUMBER ?? 'SP00324369';
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('Spark live tracker', () => {
  it('returns the number’s dated steps', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => /^\d{4}-\d{2}-\d{2}$/.test(event.local_time ?? '') && event.description)).toBe(true);
  }, 60_000);
  it('reads an impossible number as not found', async () => {
    await expect(tracker().track({ number: 'ZZ00000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

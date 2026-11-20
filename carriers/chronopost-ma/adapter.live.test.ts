import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.CHRONOPOST_MA_TRACKING_NUMBER ?? 'EW178243201FR';
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('Chronopost Maroc live tracker', () => {
  it('returns the number’s dated events', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
  }, 60_000);
  it('reads an impossible number as not found', async () => {
    await expect(tracker().track({ number: 'ZZ000000000ZZ' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.LX_PANTOS_TRACKING_NUMBER ?? 'PJP260065789';
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('LX Pantos live tracker', () => {
  it('returns the number’s scans on their wall clocks', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(event.local_time ?? '') && event.description)).toBe(true);
  }, 60_000);
  it('reads an impossible number as not found', async () => {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await expect(tracker().track({ number: 'ZZQ000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

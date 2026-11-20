import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.OVERSEAS_EXPRESS_TRACKING_NUMBER ?? '18497957';
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('Overseas Express live tracker', () => {
  it('returns the number’s scans as instants', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(event.time ?? '') && event.description)).toBe(true);
  }, 60_000);
  it('reads an impossible code as not found', async () => {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    await expect(tracker().track({ number: 'ZZ00000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

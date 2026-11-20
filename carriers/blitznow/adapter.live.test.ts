import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.BLITZNOW_TRACKING_NUMBER ?? 'GS8451715328';
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('Blitz live tracker', () => {
  it('returns the number’s status with the time the service states', async () => {
    const result = await tracker().track({ number });
    expect(result.status).not.toBe('unknown');
    expect(result.last_update).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/);
    expect(result.events!.every(event => /(?:Z|[+-]\d{2}:\d{2})$/.test(event.time ?? '') && event.description)).toBe(true);
  }, 60_000);
  it('reads an impossible number as not found', async () => {
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await expect(tracker().track({ number: 'ZZ0000000000' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

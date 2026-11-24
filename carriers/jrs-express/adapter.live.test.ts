import { describe, expect, it } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample with its branch code, unless another reference is given.
const NUMBER = process.env.JRS_EXPRESS_TRACKING_NUMBER
  ?? numbers.records.find((record) => record.number.includes('-') && record.context.assessment === 'confirmed')!.number;
const UNKNOWN = process.env.JRS_EXPRESS_UNKNOWN_NUMBER;

describe('JRS Express live retrieval', () => {
  it('retrieves the requested reference\'s scans, staged and none ahead of the read', async () => {
    const result = await direct().track({ number: directTrackingNumber('jrs-express', NUMBER) });
    expect(result.current_stage).toBeTruthy();
    expect(result.events!.length).toBeGreaterThan(0);
    const now = new Date().toISOString();
    for (const event of result.events!) {
      expect(event.time ?? event.local_time, JSON.stringify(event)).toBeTruthy();
      if (event.time) expect(new Date(event.time).toISOString() <= now).toBe(true);
    }
    expect(JSON.stringify(result)).not.toMatch(/receiver|relation|remarks/i);
  }, 45_000);

  it.skipIf(!UNKNOWN)('reads a reference the tracker holds nothing for as not found', async () => {
    await expect(direct().track({ number: directTrackingNumber('jrs-express', UNKNOWN!) })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

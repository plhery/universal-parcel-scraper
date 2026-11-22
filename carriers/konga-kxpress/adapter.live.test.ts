import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.KONGA_KXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Konga Logistics live retrieval', () => {
  it('retrieves the requested shipment', async () => {
    const result = await direct().track({ number: NUMBER });
    expect(result.events!.length).toBeGreaterThan(0);
    // Every row keeps its wall clock without a zone, none after the lookup on Lagos's clock.
    const now = DateTime.now().setZone('Africa/Lagos').toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(result.events!.every((event) => event.description && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(event.local_time ?? '') && event.local_time! <= now)).toBe(true);
    expect(result.last_update_local).toBe(result.events![0]!.local_time);
    expect(result.status).not.toBe('unknown');
  }, 45_000);

  it.skipIf(!process.env.KONGA_KXPRESS_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.KONGA_KXPRESS_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.EMIRATES_COURIER_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;
const UNKNOWN = process.env.EMIRATES_COURIER_EXPRESS_UNKNOWN_NUMBER;

describe('Emirates Courier Express live retrieval', () => {
  it('retrieves the requested parcel’s scans', async () => {
    const result = await direct().track({ number: NUMBER });
    expect(result.current_stage).toBeTruthy();
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan has its wall clock, with the offset the reply states or alone; none is in the future.
    expect(result.events!.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2})?$/.test(String(event.time ?? event.local_time)))).toBe(true);
    expect(result.events!.every((event) => !event.time || Date.parse(event.time) <= Date.now())).toBe(true);
  }, 45_000);

  it.skipIf(!UNKNOWN)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

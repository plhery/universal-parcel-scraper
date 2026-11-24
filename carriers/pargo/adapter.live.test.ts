import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.PARGO_TRACKING_NUMBER ?? numbers.records[0]!.number;
// A synthetic code of Pargo's shape that the tracker holds no order for.
const UNKNOWN = process.env.PARGO_UNKNOWN_NUMBER ?? 'PAR0000000000';

describe('Pargo live retrieval', () => {
  it('retrieves the requested order with its scans as instants', async () => {
    const result = await direct().track({ number: NUMBER });
    expect(result.current_stage).toBeTruthy();
    expect(result.last_status_text).toEqual(expect.any(String));
    const now = new Date().toISOString();
    expect(result.events!.every((event) => event.provider_code && event.time && event.time <= now)).toBe(true);
  }, 45_000);

  it('reads a code the tracker holds no order for as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

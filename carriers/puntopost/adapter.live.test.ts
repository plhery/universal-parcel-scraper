import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

// The public sample in numbers.json, unless another number is set outside the repository.
const NUMBER = process.env.PUNTOPOST_TRACKING_NUMBER ?? 'MXL0000016G39';
const UNKNOWN = process.env.PUNTOPOST_UNKNOWN_NUMBER ?? 'MXZZZZZZZZZZZZ';
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('PuntoPost live retrieval', () => {
  it('retrieves the history of the requested parcel', async () => {
    const result = await direct().track({ number: NUMBER });
    expect(result.current_stage).toBeDefined();
    // Every clock carries an offset.
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time && event.local_time === undefined && event.description && event.provider_code)).toBe(true);
  }, 45_000);

  it('reads the service’s answer for an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

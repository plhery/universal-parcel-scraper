import { describe, expect, it } from 'vitest';
import { carrierErrorKind } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.OVERSEAS_EXPRESS_TRACKING_NUMBER ?? '18497957';
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });
// I-NET's Azure gateway refuses some networks, GitHub runners included, while
// others get the answer: a refusal proves neither breakage nor health.
const REFUSED = 'Overseas Express\'s gateway refused this network: the guest lookup remains unverified';

describe('Overseas Express live tracker', () => {
  it('returns the number’s scans as instants', async (context) => {
    let result: CarrierResult;
    try {
      result = await tracker().track({ number });
    } catch (error) {
      if (carrierErrorKind(error) === 'challenge') return context.skip(REFUSED);
      throw error;
    }
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(event.time ?? '') && event.description)).toBe(true);
  }, 60_000);
  it('reads an impossible code as not found', async (context) => {
    await new Promise(resolve => setTimeout(resolve, 5_000));
    const error: unknown = await tracker().track({ number: 'ZZ00000000' }).then(() => undefined, caught => caught);
    if (carrierErrorKind(error) === 'challenge') return context.skip(REFUSED);
    expect(error).toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.KOREAN_AIR_CARGO_TRACKING_NUMBER;

it.skipIf(!number)('reads the statuses of a Korean Air Cargo waybill, or its explicit not-found answer', async () => {
  try {
    const result = await tracker.track({ number: number! });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_code: expect.stringMatching(/^[A-Z]{3}$/), local_time: expect.any(String) }),
    ]));
  } catch (error) {
    // The published waybills are older than the tracker keeps; it answers them "No tracking data available."
    expect(error).toMatchObject({ kind: 'not_found' });
  }
}, 20_000);

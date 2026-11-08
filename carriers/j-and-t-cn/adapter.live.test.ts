import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const KNOWN = process.env.J_AND_T_CN_TRACKING_NUMBER;
// The last four digits of the parcel's recipient's or sender's phone, kept outside the repository.
const DIGITS = process.env.J_AND_T_CN_PHONE_DIGITS;

describe('J&T Express China live retrieval', () => {
  it.skipIf(!KNOWN || !DIGITS)('retrieves the history of the requested waybill with its phone digits, providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: KNOWN!, carrier: 'j-and-t-cn', phoneDigits: DIGITS! });
    expect(answer).toMatchObject({ carrier: 'j-and-t-cn', source: 'j-and-t-cn' });
    expect(answer.attempts[0]).toMatchObject({ source: 'j-and-t-cn', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && !event.local_time
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(String(event.time)))).toBe(true);
  }, 45_000);

  it.skipIf(!KNOWN)('asks for the phone digits without a request', async () => {
    await expect(direct().track({ number: KNOWN! })).rejects.toMatchObject({ kind: 'input_required', field: 'phoneDigits' });
  });
});

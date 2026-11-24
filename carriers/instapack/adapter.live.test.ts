import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample, unless another code is given.
const NUMBER = process.env.INSTAPACK_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Instapack live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'instapack' });
    expect(answer).toMatchObject({ carrier: 'instapack', source: 'instapack' });
    expect(answer.attempts[0]).toMatchObject({ source: 'instapack', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    // Every scan keeps its wall clock.
    for (const event of result.events) expect(event.local_time).toEqual(expect.any(String));
    if (!process.env.INSTAPACK_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '¡Hemos realizado la entrega!' });
      expect(result.events.map((event) => event.stage)).toContain('failed_attempt');
    }
  }, 45_000);

  it('reads a code the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.INSTAPACK_UNKNOWN_NUMBER ?? 'CNES90000000017' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

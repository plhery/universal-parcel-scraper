import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.CTM_MESSAGERIE_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('CTM Messagerie live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'ctm-messagerie' });
    expect(answer).toMatchObject({ carrier: 'ctm-messagerie', source: 'ctm-messagerie' });
    expect(answer.attempts[0]).toMatchObject({ source: 'ctm-messagerie', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Wall clocks in Morocco, without an offset.
    for (const event of result.events) expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time))).toBe(true);
    if (!process.env.CTM_MESSAGERIE_TRACKING_NUMBER) expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Livré - Conforme' });
  }, 45_000);

  it('reads a number the tracker does not know as not found', async () => {
    await expect(direct().track({ number: process.env.CTM_MESSAGERIE_UNKNOWN_NUMBER ?? 'ZZ00000000QQ' })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

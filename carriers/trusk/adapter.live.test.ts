import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample's order link, unless another is given.
const LINK = process.env.TRUSK_TRACKING_URL ?? `https://track.trusk.com/${numbers.records[0]!.number}`;
const ORDER = new URL(LINK).pathname.split('/').at(-1)!;

describe('Trusk live retrieval', () => {
  it('retrieves the order its link names with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: ORDER, carrier: 'trusk', trackingUrl: LINK });
    expect(answer).toMatchObject({ carrier: 'trusk', source: 'trusk' });
    expect(answer.attempts[0]).toMatchObject({ source: 'trusk', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    for (const event of result.events) expect(event.time).toEqual(expect.any(String));
    if (!process.env.TRUSK_TRACKING_URL) expect(result).toMatchObject({ current_stage: 'delivered', sender_name: 'Ikea' });
  }, 45_000);

  it('reads an order id the lookup does not know as not found', async () => {
    const other = process.env.TRUSK_UNKNOWN_ORDER ?? 'Zz9Zz9Zz9Z';
    await expect(direct().track({ number: other.toUpperCase(), trackingUrl: `https://track.trusk.com/${other}` })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

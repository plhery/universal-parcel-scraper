import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.E24_TRACKING_NUMBER ?? numbers.records[0]!.number;
// A synthetic number of E24's shape, unless another is given.
const UNKNOWN = process.env.E24_UNKNOWN_NUMBER ?? '000000-00000000';

describe('E24 live retrieval', () => {
  it('retrieves the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'e24metro-ca' });
    expect(answer).toMatchObject({ carrier: 'e24metro-ca', source: 'e24metro-ca' });
    expect(answer.attempts[0]).toMatchObject({ source: 'e24metro-ca', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Statuses with their wording and an instant, none in the future.
    expect(result.events.every((event) => event.description && event.time && Date.parse(event.time) <= Date.now())).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

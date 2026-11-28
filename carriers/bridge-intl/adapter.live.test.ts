import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another number is given.
const NUMBER = process.env.BRIDGE_INTL_TRACKING_NUMBER ?? numbers.records[0]!.number;
// A synthetic number of the sample's shape, unless another is given.
const UNKNOWN = process.env.BRIDGE_INTL_UNKNOWN_NUMBER ?? 'AU000000000SG';

describe('Bridge Intl live retrieval', () => {
  it('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'bridge-intl' });
    expect(answer).toMatchObject({ carrier: 'bridge-intl', source: 'bridge-intl' });
    expect(answer.attempts[0]).toMatchObject({ source: 'bridge-intl', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Rows dated to the day, with their text.
    expect(result.events.every((event) => event.description && /^\d{4}-\d{2}-\d{2}$/.test(String(event.local_time)))).toBe(true);
  });

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });
});

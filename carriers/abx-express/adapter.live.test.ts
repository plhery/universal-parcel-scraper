import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const NUMBER = process.env.ABX_EXPRESS_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('ABX Express live retrieval', () => {
  it('retrieves the consignment history with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'abx-express' });
    expect(answer).toMatchObject({ carrier: 'abx-express', source: 'abx-express' });
    expect(answer.attempts[0]).toMatchObject({ source: 'abx-express', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.every((event) => event.description && event.local_time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/base64|phoneNo|epod\./i);
  }, 45_000);

  it('reads an unknown consignment number as not found', async () => {
    const unknown = process.env.ABX_EXPRESS_UNKNOWN_NUMBER ?? 'CNMYA990417263';
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

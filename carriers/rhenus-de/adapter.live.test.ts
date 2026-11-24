import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

// The public sample with the delivery postcode its source gives, unless another order is given.
const NUMBER = process.env.RHENUS_DE_TRACKING_NUMBER ?? numbers.records[0]!.number;
const POSTCODE = process.env.RHENUS_DE_POSTCODE ?? (process.env.RHENUS_DE_TRACKING_NUMBER ? undefined : '47807');
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

describe('Rhenus Germany live retrieval', () => {
  it.skipIf(!POSTCODE)('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'rhenus-de', postcode: POSTCODE });
    expect(answer).toMatchObject({ carrier: 'rhenus-de', source: 'rhenus-de' });
    expect(answer.attempts[0]).toMatchObject({ source: 'rhenus-de', kind: 'ok' });
    const { result } = answer;
    expect(result.events.length).toBeGreaterThan(0);
    // Every step keeps the instant and offset the service gives.
    expect(result.events.every((event) => event.description && INSTANT.test(String(event.time)))).toBe(true);
  }, 30_000);

  it.skipIf(!process.env.RHENUS_DE_UNKNOWN_NUMBER)('reads an unknown order as inconclusive, as a wrong postcode is', async () => {
    await expect(direct().track({ number: process.env.RHENUS_DE_UNKNOWN_NUMBER!, postcode: POSTCODE ?? '10115' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 30_000);
});

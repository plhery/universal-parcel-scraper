import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another order number is given.
const NUMBER = process.env.HOME_DELIVERY_TEAM_TRACKING_NUMBER ?? numbers.records[0]!.number;

describe('Home Delivery Team live retrieval', () => {
  it('retrieves the requested order with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'home-delivery-team' });
    expect(answer).toMatchObject({ carrier: 'home-delivery-team', source: 'home-delivery-team' });
    expect(answer.attempts[0]).toMatchObject({ source: 'home-delivery-team', kind: 'ok' });
    const { events } = answer.result;
    expect(events.length).toBeGreaterThan(0);
    // Steps on Budapest's wall clock, none in the future, each with its status title; an instant
    // beside one is deduced from Hungary's zone.
    expect(events.every((event) => event.provider_code && event.description && (!event.time || event.time_zone === 'Europe/Budapest')
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)) && String(event.local_time) <= new Date().toISOString())).toBe(true);
    expect(events.at(-1)!.stage).toBeDefined();
  }, 45_000);

  it.skipIf(!process.env.HOME_DELIVERY_TEAM_UNKNOWN_NUMBER)('reads an unknown order as not found', async () => {
    await expect(direct().track({ number: process.env.HOME_DELIVERY_TEAM_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

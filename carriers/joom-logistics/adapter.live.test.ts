import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample the RU fixture answers.
const SAMPLE = numbers.records[0]!.number;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe('Joom Logistics live retrieval', () => {
  it.skipIf(!process.env.JOOM_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.JOOM_LOGISTICS_TRACKING_NUMBER!, carrier: 'joom-logistics' });
    expect(answer).toMatchObject({ carrier: 'joom-logistics', source: 'joom-logistics' });
    expect(answer.attempts[0]).toMatchObject({ source: 'joom-logistics', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan keeps its wording and either Joom Logistics' instant or the relayed wall clock.
    expect(answer.result.events.every((event) => event.description
      && (INSTANT.test(String(event.time)) !== WALL_CLOCK.test(String(event.local_time))))).toBe(true);
  }, 45_000);

  it('retrieves the public sample’s history, its own scans as instants and the post’s as wall clocks', async () => {
    const result = await direct().track({ number: SAMPLE });
    expect(result).toMatchObject({ current_stage: 'delivered', destination_country: 'RU' });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(10);
    expect(events.filter((event) => event.provider_code === 'parcelCheckIn').every((event) => INSTANT.test(String(event.time)))).toBe(true);
    expect(events.filter((event) => event.provider_code === 'confirmedDelivery')
      .every((event) => WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it('finds the public sample filed with hyphens from its number without them', async () => {
    const hyphenated = numbers.records.find((record) => record.number.includes('-'))!.number;
    await expect(direct().track({ number: hyphenated.replaceAll('-', '') })).resolves.toMatchObject({ current_stage: 'delivered' });
  }, 45_000);

  it('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.JOOM_LOGISTICS_UNKNOWN_NUMBER ?? 'ZZ729461835XX' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

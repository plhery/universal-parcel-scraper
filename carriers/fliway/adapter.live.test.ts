import { describe, expect, it } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample and an invented number, unless others are given.
const NUMBER = process.env.FLIWAY_TRACKING_NUMBER ?? numbers.records[0]!.number;
const UNKNOWN = process.env.FLIWAY_UNKNOWN_NUMBER ?? 'QXZ4071953';
const kindOf = (answer: unknown) => (answer as { kind?: string }).kind;

// RedShield's firewall refuses some addresses outright; from those, every lookup is a challenge, never a missing parcel.
describe('Fliway live retrieval', () => {
  it('retrieves the requested consignment and its history, or meets the firewall', async () => {
    const answer = await direct().track({ number: NUMBER }).catch((error: unknown) => error);
    if (kindOf(answer) === 'challenge') return;
    const { events } = answer as CarrierResult;
    expect(events!.length).toBeGreaterThan(0);
    // Wall clocks dated on New Zealand's clock, none in the future.
    expect(events!.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time))
      && event.time_zone === 'Pacific/Auckland' && event.time && Date.parse(event.time) <= Date.now() && event.description)).toBe(true);
  }, 45_000);

  it('reads an unknown number as not found, or meets the firewall', async () => {
    const answer = await direct().track({ number: UNKNOWN }).catch((error: unknown) => error);
    expect(['not_found', 'challenge']).toContain(kindOf(answer));
  }, 45_000);
});

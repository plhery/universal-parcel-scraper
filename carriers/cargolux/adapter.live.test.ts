import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const number = process.env.CARGOLUX_TRACKING_NUMBER ?? numbers.records[0]!.number;
// An invented waybill whose check digit holds.
const unknown = process.env.CARGOLUX_UNKNOWN_NUMBER ?? '172-12345675';
const tracker = () => adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null });

describe('Cargolux live tracker', () => {
  it('returns the waybill’s events with their stations’ offsets', async () => {
    const result = await tracker().track({ number });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => event.time && /[+-]\d{2}:\d{2}$|Z$/.test(event.time) && event.description && event.location)).toBe(true);
  }, 60_000);
  it('reads an unknown waybill as not found', async () => {
    await expect(tracker().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

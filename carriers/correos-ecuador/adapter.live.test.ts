import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The public sample, unless another is given.
const number = process.env.CORREOS_ECUADOR_TRACKING_NUMBER ?? numbers.records[0]!.number;
const unknown = process.env.CORREOS_ECUADOR_UNKNOWN_NUMBER;

describe('Servicios Postales del Ecuador live retrieval', () => {
  it('retrieves the requested item\'s history as wall clocks, without who took it', async () => {
    const result = await direct().track({ number });
    expect(result.current_stage).toBeTruthy();
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every((event) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(String(event.local_time)) && event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Recibido por|\d{10}/i);
  }, 45_000);

  it.skipIf(!unknown)('reads a code the tracker does not know as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

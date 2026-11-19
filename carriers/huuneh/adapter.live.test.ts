import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Huuneh live retrieval', () => {
  it.skipIf(!process.env.HUUNEH_TRACKING_NUMBER)('reads the requested waybill’s history on wall clocks', async () => {
    const result = await direct().track({ number: process.env.HUUNEH_TRACKING_NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(event.local_time)))).toBe(true);
    await expect(direct().recognize!(process.env.HUUNEH_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.HUUNEH_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.HUUNEH_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(direct().recognize!(process.env.HUUNEH_UNKNOWN_NUMBER!)).resolves.toEqual({ known: false });
  }, 45_000);
});

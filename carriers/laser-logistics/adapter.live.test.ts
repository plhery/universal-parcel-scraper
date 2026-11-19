import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Laser Logistics live retrieval', () => {
  it.skipIf(!process.env.LASER_LOGISTICS_TRACKING_NUMBER)('retrieves the history of the requested waybill', async () => {
    const result = await direct().track({ number: process.env.LASER_LOGISTICS_TRACKING_NUMBER! }, { budgetMs: 30_000 });
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan has wording, its event code and an instant on South Africa's clock.
    expect(result.events!.every((event) => event.description && event.provider_code && event.time?.endsWith('+02:00'))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.LASER_LOGISTICS_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.LASER_LOGISTICS_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  }, 45_000);

  it.skipIf(!process.env.LASER_LOGISTICS_UNKNOWN_NUMBER)('reads an unknown waybill as not found', async () => {
    await expect(direct().track({ number: process.env.LASER_LOGISTICS_UNKNOWN_NUMBER! }, { budgetMs: 30_000 })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

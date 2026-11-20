import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

describe('Yol Kargo live retrieval', () => {
  it.skipIf(!process.env.YOL_KARGO_TRACKING_NUMBER)('retrieves dated movements for the requested shipment with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.YOL_KARGO_TRACKING_NUMBER!, carrier: 'yol-kargo' });
    expect(answer).toMatchObject({ carrier: 'yol-kargo', source: 'yol-kargo', attempts: [{ source: 'yol-kargo', kind: 'ok' }] });
    expect(answer.result.events.length).toBeGreaterThan(0);
    expect(answer.result.events.every((event) => event.description && WALL_CLOCK.test(String(event.local_time)))).toBe(true);
  }, 45_000);

  it.skipIf(!process.env.YOL_KARGO_ARAS_TRACKING_NUMBER)('follows a shipment handed to Aras Kargo', async () => {
    const result = await direct().track({ number: process.env.YOL_KARGO_ARAS_TRACKING_NUMBER! }, { budgetMs: 30_000 });
    expect(result).toMatchObject({ delivery_carrier: 'aras-kargo', delivery_tracking_number: expect.stringMatching(/^\d{13}$/) });
    expect(result.events?.length).toBeGreaterThan(0);
  }, 45_000);

  it.skipIf(!process.env.YOL_KARGO_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.YOL_KARGO_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

import { describe, expect, it } from 'vitest';
import { PigeonshipTracker } from './adapter.js';

const positive = process.env.PIGEONSHIP_TRACKING_NUMBER;
const unknown = process.env.PIGEONSHIP_UNKNOWN_NUMBER ?? '7P6P543H210H98H7PP';

describe('pigeonship live guest retrieval', () => {
  it.skipIf(!positive)('reads an order bound to the whole number', async () => {
    const result = await new PigeonshipTracker().fetch(positive!);
    expect(result.summary_only).toBe(true);
    expect(result.provider_code).toMatch(/^\d+$/);
    expect(result.last_status_text).toBeTruthy();
  }, 20_000);
  it('reports an unknown number as not found', async () => {
    await expect(new PigeonshipTracker().fetch(unknown)).rejects.toMatchObject({ kind: 'not_found' });
  }, 20_000);
});

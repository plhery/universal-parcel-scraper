import { describe, expect, it } from 'vitest';
import { CeleroTracker } from './adapter.js';

const positive = process.env.CELERO_TRACKING_NUMBER ?? 'MU120109191821';
const unknown = process.env.CELERO_UNKNOWN_NUMBER ?? 'MU999999999999';

describe('Celero live guest retrieval', () => {
  it('reads a parcel bound to the whole number', async () => {
    const result = await new CeleroTracker().fetch(positive);
    expect(result.status).not.toBe('unknown');
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.local_time && event.description)).toBe(true);
  }, 30_000);
  it('reports an unknown number as not found', async () => {
    await expect(new CeleroTracker().fetch(unknown)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

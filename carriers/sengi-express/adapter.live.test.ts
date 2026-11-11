import { describe, expect, it } from 'vitest';
import { SengiExpressTracker } from './adapter.js';

describe('Sengi Express guest retrieval', () => {
  it.skipIf(!process.env.SENGI_EXPRESS_TRACKING_NUMBER)('retrieves the rows of a parcel Sengi carries', async () => {
    const result = await new SengiExpressTracker().fetch(process.env.SENGI_EXPRESS_TRACKING_NUMBER!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description && (event.time || event.local_time))).toBe(true);
  }, 30_000);
  it.skipIf(!process.env.SENGI_EXPRESS_UNKNOWN_NUMBER)('reads the empty reply as not found', async () => {
    await expect(new SengiExpressTracker().fetch(process.env.SENGI_EXPRESS_UNKNOWN_NUMBER!)).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

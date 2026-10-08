import { describe, expect, it } from 'vitest';
import { HermesTracker } from './adapter.js';

describe('Hermes live anonymous tracking', () => {
  it.skipIf(!process.env.HERMES_TRACKING_NUMBER)('returns the order behind a private parcel number', async () => {
    const result = await new HermesTracker().fetch(process.env.HERMES_TRACKING_NUMBER!);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.last_status_text).toBeTruthy();
  });

  it('maps the official empty-order response for a wrong number to a clean 404', async () => {
    await expect(new HermesTracker().fetch('12345678')).rejects.toMatchObject({
      name: 'NotFoundError',
      status: 404,
      message: 'Hermes could not locate the shipment',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { YandexDeliveryTracker } from './adapter.js';

// The tracking page's own example, and a number of its layout that it does not know.
const positive = process.env.YANDEX_DELIVERY_TRACKING_NUMBER ?? 'LO-835645864';
const unknown = process.env.YANDEX_DELIVERY_UNKNOWN_NUMBER ?? 'LO-000000000';

describe('yandex-delivery live guest retrieval', () => {
  it('reads a history bound to the whole number', async () => {
    const result = await new YandexDeliveryTracker().fetch(positive);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.description)).toBe(true);
    expect(result.events!.some(event => event.local_time)).toBe(true);
  }, 20_000);

  it('reads an unknown number as not found', async () => {
    await expect(new YandexDeliveryTracker().fetch(unknown)).rejects.toMatchObject({ kind: 'not_found' });
  }, 20_000);
});

import { describe, expect, it } from 'vitest';
import { FlechaAmarillaTracker } from './adapter.js';

const positive = process.env.FLECHA_AMARILLA_TRACKING_NUMBER;
const unknown = process.env.FLECHA_AMARILLA_UNKNOWN_NUMBER;

describe('flecha-amarilla live guest retrieval', () => {
  it.skipIf(!positive)('reads a guía bound to the whole number', async () => {
    const result = await new FlechaAmarillaTracker().fetch(positive!);
    expect(result.events!.length).toBeGreaterThan(0);
    expect(result.events!.every(event => event.time && event.description)).toBe(true);
  }, 20_000);
  it.skipIf(!unknown)('reports an unknown guía as inconclusive, never as found', async () => {
    await expect(new FlechaAmarillaTracker().fetch(unknown!)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  }, 20_000);
});

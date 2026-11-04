import { describe, expect, it } from 'vitest';
import type { CarrierResult } from '../../core/result/index.js';
import { HermesTracker } from './adapter.js';
import corpus from './numbers.json' with { type: 'json' };

// Public reports myhes.de returned an order for. An order that has aged out of
// the lookup gets HTTP 400, the answer to a number it does not take.
const confirmed = (corpus.records as { number: string; quarantine?: boolean; context?: { assessment?: string } }[])
  .filter(record => record.context?.assessment === 'confirmed' && !record.quarantine).map(record => record.number);

describe('Hermes live anonymous tracking', () => {
  it('still returns a confirmed public delivered order', async () => {
    expect(confirmed.length).toBeGreaterThan(0);
    const orders: CarrierResult[] = [];
    for (const number of confirmed) {
      const result = await new HermesTracker().fetch(number).catch((error: unknown) => {
        expect([400, 404]).toContain((error as { status?: unknown }).status);
        return null;
      });
      if (result) orders.push(result);
    }
    // When every record has aged out, add a fresher public report to numbers.json.
    expect(orders.length).toBeGreaterThan(0);
    for (const result of orders) {
      expect(result).toMatchObject({ status: 'delivered', last_status_text: expect.stringMatching(/zugestellt|geliefert/i) });
    }
  });

  it('maps the official empty-order response for a wrong number to a clean 404', async () => {
    await expect(new HermesTracker().fetch('12345678')).rejects.toMatchObject({
      name: 'NotFoundError',
      status: 404,
      message: 'Hermes could not locate the shipment',
    });
  });
});

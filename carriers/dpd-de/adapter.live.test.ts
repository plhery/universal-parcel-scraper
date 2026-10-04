import { describe, expect, it } from 'vitest';
import { DPDTracker } from '../dpd/adapter.js';

const number = (process.env.DPD_DE_TRACKING_NUMBER ?? '').trim();

describe('DPD Germany live guest tracking', () => {

  it.runIf(Boolean(number))('returns caller-supplied German shipment history', async () => {
    const result = await new DPDTracker({ country: 'DE', timeoutMs: 15_000, budgetMs: 20_000 }).fetch(number);
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.status).not.toBe('unknown');
    expect(result).not.toHaveProperty('receiver');
  }, 25_000);
});

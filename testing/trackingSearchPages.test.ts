import { describe, expect, it } from 'vitest';
import { CARRIERS } from '../core/catalog/index.js';
import type { CarrierId } from '../generated/catalog.js';
import { carriersWithoutSearchPage, uncheckedSearchPages } from './trackingSearchPages.js';

describe('carrier search pages', () => {
  it('names a search page for every carrier with a tracking link, or says why it has none', () => {
    const missing = Object.values(CARRIERS)
      .filter((carrier) => carrier.trackingUrl && !carrier.trackingSearchUrl && !carriersWithoutSearchPage[carrier.id])
      .map((carrier) => carrier.id);
    expect(missing, 'Add portal.searchUrl to carrier.json or a reason to carriersWithoutSearchPage').toEqual([]);
  });

  it('keeps reasons only for carriers without a search page', () => {
    for (const carrier of Object.keys(carriersWithoutSearchPage) as CarrierId[]) {
      expect(CARRIERS[carrier].trackingSearchUrl, carrier).toBeUndefined();
    }
  });

  it('keeps exclusions from the weekly check only for carriers with a search page', () => {
    for (const carrier of Object.keys(uncheckedSearchPages) as CarrierId[]) {
      expect(CARRIERS[carrier].trackingSearchUrl, carrier).toBeDefined();
    }
  });
});

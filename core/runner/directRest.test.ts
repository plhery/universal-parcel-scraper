import { describe, expect, it, vi } from 'vitest';
import { TrawlClient } from '../transport/trawl.js';
import { DIRECT_REST_MS, DirectRest } from './directRest.js';

describe('DirectRest', () => {
  it("rests a carrier's direct step on one browser service until the rest is over", () => {
    const service = new TrawlClient('https://browser.example.test/rest');
    const rest = new DirectRest('example', service);
    expect(rest.resting).toBe(false);
    rest.refused();
    expect(rest.resting).toBe(true);
    // Another tracker of the carrier on the same service shares the rest; another carrier or service does not.
    expect(new DirectRest('example', new TrawlClient('https://browser.example.test/rest')).resting).toBe(true);
    expect(new DirectRest('other', service).resting).toBe(false);
    expect(new DirectRest('example', new TrawlClient('https://browser.example.test/elsewhere')).resting).toBe(false);
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DIRECT_REST_MS + 1);
    try { expect(rest.resting).toBe(false); } finally { later.mockRestore(); }
  });

  it('never rests without a browser service', () => {
    const rest = new DirectRest('example', null);
    rest.refused();
    expect(rest.resting).toBe(false);
  });
});

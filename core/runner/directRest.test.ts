import { describe, expect, it, vi } from 'vitest';
import { TrawlClient } from '../transport/trawl.js';
import { DIRECT_REST_MS, DirectRest } from './directRest.js';
import { keepAdapterHolds, resetAdapterHolds, serviceTag, type AdapterHold } from './holds.js';

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

  it("saves a rest to the host's holds without the service's address, and takes it up after a restart", async () => {
    const saved: AdapterHold[] = [];
    await keepAdapterHolds({ load: async () => [], save: async (hold) => { saved.push(hold); } });
    try {
      const service = new TrawlClient('https://browser.example.test/saved');
      new DirectRest('example-saved', service).refused();
      expect(saved).toEqual([{ key: `direct-rest/example-saved ${serviceTag(service.endpoint.href)}`, until: expect.any(Number) }]);
      expect(JSON.stringify(saved)).not.toContain('browser.example.test');
      // Another carrier stands in for the restarted process; a saved rest longer than the rule is cut to it.
      const restarted = `example-restarted ${serviceTag(service.endpoint.href)}`;
      await keepAdapterHolds({ load: async () => [{ key: `direct-rest/${restarted}`, until: Date.now() + 2 * DIRECT_REST_MS }],
        save: async () => undefined });
      expect(new DirectRest('example-restarted', service).resting).toBe(true);
      const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + DIRECT_REST_MS + 1_000);
      try { expect(new DirectRest('example-restarted', service).resting).toBe(false); } finally { later.mockRestore(); }
    } finally {
      resetAdapterHolds();
    }
  });

  it('never rests without a browser service', () => {
    const rest = new DirectRest('example', null);
    rest.refused();
    expect(rest.resting).toBe(false);
  });
});

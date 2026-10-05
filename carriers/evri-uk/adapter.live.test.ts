import { describe, expect, it } from 'vitest';
import { EvriUkTracker } from './adapter.js';

const executablePath = process.env.TRACKING_CHROMIUM_PATH;
const number = process.env.EVRI_UK_TRACKING_NUMBER;

describe('Evri UK fresh browser tracking', () => {
  it('reports the missing browser without attempting direct HTTP', () => {
    expect(() => new EvriUkTracker().fetch('H000000000000001')).toThrow('TRACKING_CHROMIUM_PATH');
  });

  it.runIf(Boolean(executablePath && number))('returns dated anonymous history without a postcode', async () => {
    const result = await new EvriUkTracker({ executablePath }).fetch(number!, { budgetMs: 45_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some(event => event.time)).toBe(true);
    expect(result.tracking_source).toBe('structured-web-response');
    expect(Object.keys(result).some(key => /recipient|receiver|address|photo|signature|token/i.test(key))).toBe(false);
  }, 50_000);
});

import { describe, expect, it } from 'vitest';
import { EvriUkTracker } from './adapter.js';

const executablePath = process.env.TRACKING_CHROMIUM_PATH;
const number = process.env.EVRI_UK_TRACKING_NUMBER;

describe('Evri UK live tracking', () => {
  it('reports the missing browser when the guest API is disabled', () => {
    expect(() => new EvriUkTracker({ key: '' }).fetch('H000000000000001')).toThrow('TRACKING_CHROMIUM_PATH');
  });

  it('keeps a reference the guest API rejects inconclusive', async () => {
    await expect(new EvriUkTracker().fetch('H000000000000001', { budgetMs: 15_000 })).rejects.toMatchObject({ kind: 'indeterminate' });
  }, 20_000);

  it.runIf(Boolean(number))('returns dated anonymous history from the guest API without a postcode', async () => {
    const result = await new EvriUkTracker().fetch(number!, { budgetMs: 15_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.events?.some(event => event.time)).toBe(true);
    expect(Object.keys(result).some(key => /recipient|receiver|address|photo|signature|token/i.test(key))).toBe(false);
  }, 20_000);

  it.runIf(Boolean(executablePath && number))('returns the same history through the page', async () => {
    const direct = await new EvriUkTracker().fetch(number!, { budgetMs: 15_000 });
    const result = await new EvriUkTracker({ executablePath, key: '' }).fetch(number!, { budgetMs: 45_000 });
    expect(result.events?.length).toBeGreaterThan(0);
    expect(result.tracking_source).toBe('structured-web-response');
    expect(result.events).toEqual(direct.events);
    expect(Object.keys(result).some(key => /recipient|receiver|address|photo|signature|token/i.test(key))).toBe(false);
  }, 70_000);
});

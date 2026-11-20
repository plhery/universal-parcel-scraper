import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/outbound.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');

describe('Post Aruba IPS history', () => {
  it('preserves scan order and office-local clocks across posts', () => {
    const result = parseTracking(found, 'RR927248745AW');
    expect(result).toMatchObject({ current_stage: 'customs', last_update_local: '2025-06-22T07:44:00' });
    expect(result.events).toHaveLength(7);
    expect(result.events?.at(-1)).toMatchObject({ stage: 'accepted', local_time: '2025-06-19T09:59:18' });
    expect(result.events?.[0]).toMatchObject({ location: 'ISC MIAMI FL (USPS), United States of America' });
  });

  it('respects the no-information notice and refuses a different item', () => {
    expect(() => parseTracking(missing, 'RR999999995AW')).toThrow(NotFoundError);
    expect(() => parseTracking(found, 'RR999999995AW')).toThrow(/another item/i);
    expect(() => parseTracking('<html></html>', 'RR999999995AW')).toThrow(/missing Post Aruba/i);
  });

  it('is asked about the items Aruba issues and answers from the item page', async () => {
    // Synthetic codes with valid S10 check digits.
    expect(recognitionAskedCarriers('RR123456785AW')).toContain('aruba-post');
    expect(recognitionAskedCarriers('RR123456785CN')).not.toContain('aruba-post');
    const carrier = (body: string) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'Content-Type': 'text/html' } }));
      return { fetcher, aruba: adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null }) };
    };
    await expect(carrier(found).aruba.recognize!('RR927248745AW')).resolves.toMatchObject({ known: true });
    await expect(carrier(missing).aruba.recognize!('RR123456785AW')).resolves.toEqual({ known: false });
    const unasked = carrier(found);
    await expect(unasked.aruba.recognize!('1Z999AA10123456784')).resolves.toEqual({ known: false });
    expect(unasked.fetcher).not.toHaveBeenCalled();
  });
});

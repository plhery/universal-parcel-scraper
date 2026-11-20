import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseLexThaiSearch } from './parser.js';
import found from './fixtures/found.json' with { type: 'json' };
import unknown from './fixtures/unknown.json' with { type: 'json' };

const number = 'LEXPU0718466614';

describe('LEX Thailand guest tracking', () => {
  it('reads the shared LEX status as a Thai summary', () => {
    expect(parseLexThaiSearch(found, number)).toMatchObject({ current_stage: 'delivered',
      provider_code: 'domestic_delivered', timezone: 'Asia/Bangkok', summary_only: true, events: [] });
  });

  it('requires a Thai leg when the whole number matches', () => {
    const data = structuredClone(found);
    data.data[0]!.firstMileShippingProvider = 'Cainiao';
    expect(parseLexThaiSearch(data, number)).toMatchObject({ status: 'delivered' });
    data.data[0]!.lastMileShippingProvider = 'LEX MY';
    expect(() => parseLexThaiSearch(data, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLexThaiSearch(found, 'LEXPU9900000007')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLexThaiSearch(unknown, 'LEXDO9900000007')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('tracks only through the Thai tenant and the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(found)));
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null,
      browserExecutablePath: null, userAgent: 'Test/1.0' });
    await expect(tracker.track({ number: 'lexpu 0718466614' })).resolves.toMatchObject({ status: 'delivered' });
    expect(tracker.recognize).toBeUndefined();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://lex.th/api/search_packages', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ trackingNumbers: [number] }), signal: expect.any(AbortSignal),
    }));
  });
});

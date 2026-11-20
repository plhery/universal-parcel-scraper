import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const demo = fixture('demo');
const notFound = fixture('not-found');
const control = 'SD-THISISATEST0';

describe('Swift Drop tracking page', () => {
  it('reads the published order as an undated status summary', () => {
    expect(parseTracking(demo, 'SD-DEMO')).toEqual({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'explicit_mapping',
      last_status_text: 'In transit', last_update: null, expected_delivery: null,
      summary_only: true, events: [],
    });
  });

  it('requires the whole order number next to the status', () => {
    expect(() => parseTracking(demo, 'SD-DEMO0')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports a missing order only for the number in the native notice', () => {
    expect(() => parseTracking(notFound, control)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(notFound, 'SD-OTHER')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('keeps a changed page and challenge separate from a missing order', () => {
    expect(() => parseTracking('<h1>In transit</h1>', control)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', control)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('preserves the wording of an unmapped status', () => {
    expect(parseTracking(demo.replace('>In transit</h1>', '>Awaiting handover</h1>'), 'SD-DEMO')).toMatchObject({
      status: 'unknown', last_status_text: 'Awaiting handover', summary_only: true,
    });
  });
});

describe('Swift Drop direct adapter', () => {
  it('passes the environment user agent and rebuilds the hyphen for stored numbers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(demo));
    const tracker = adapter({ fetcher, userAgent: 'Swift Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'sdDemo' }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://swiftdrop.ae/track/SD-DEMO', expect.objectContaining({
      signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': 'Swift Test' }),
    }));
  });

  it('dispatches an explicitly selected carrier through the facade', async () => {
    const reply = demo.replace('Tracking demo', 'Tracking SD-THISISATEST0').replace('SD-DEMO<!-- --> · demo', control);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(reply));
    const tracker = createTracker({ fetcher, providers: [] });
    await expect(tracker.track({ carrier: 'swift-drop-ae', number: control }, { budgetMs: 2_000 })).resolves.toMatchObject({
      carrier: 'swift-drop-ae',
      source: 'swift-drop-ae',
      result: { status: 'in_transit' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid references without contacting the carrier', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'OTHER123' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

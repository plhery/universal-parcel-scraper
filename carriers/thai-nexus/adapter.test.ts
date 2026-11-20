import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const demo = fixture('demo');
const number = 'TNX1783820599067POM';

describe('Thai Nexus public tracking', () => {
  it('reads the real timeline with the explicit scan offsets', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Delivered', last_update: '2026-07-21T05:24:00Z',
    });
    expect(result.events).toHaveLength(11);
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered', time: '2026-07-21T05:24:00Z', stage: 'delivered' });
    expect(result.events?.slice(1, 10).every(event => event.stage === 'in_transit')).toBe(true);
    expect(result.events?.at(-1)).toMatchObject({ description: 'Created', time: '2026-07-12T01:51:08.005Z', stage: 'registered' });
  });

  it('leaves the official four-event demo in transit', () => {
    const result = parseTracking(demo, 'SR-FW-000123-1');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit' });
    expect(result.events).toHaveLength(4);
  });

  it('distinguishes an absent shipment from a different reference, a missing offset, or a challenge', () => {
    expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(example, 'ZZZZ000000000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('05:24:00+00:00', '05:24:00'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('uses the public URL and restores the printed dashes in the compact demo', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(example)).mockResolvedValueOnce(new Response(demo));
    const tracker = adapter({
      fetcher, userAgent: 'Thai Nexus Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: number.toLowerCase() })).resolves.toMatchObject({ status: 'delivered' });
    await expect(tracker.track({ number: 'SRFW0001231' })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://tracking.thainexus.co.th/track/TNX1783820599067POM',
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(fetcher).toHaveBeenNthCalledWith(2, 'https://tracking.thainexus.co.th/track/SR-FW-000123-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

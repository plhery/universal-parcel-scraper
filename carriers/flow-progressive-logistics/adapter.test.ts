import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');
const number = 'FLOW1224685';

describe('FLOW guest waybill tracking', () => {
  it('reads fourteen dated updates and stages the confirmed milestones', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'explicit_mapping',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2026-10-29T13:10',
    });
    expect(result.events).toHaveLength(14);
    expect(result.events?.map(event => [event.description, event.stage])).toEqual([
      ['Delivered', 'delivered'],
      ['delivery_arrival', undefined],
      ['accept', undefined],
      ['delivery_scheduled', undefined],
      ['reachedathub', 'in_transit'],
      ['outscan_at_hub', 'in_transit'],
      ['intransittohub', 'in_transit'],
      ['inscan_at_hub', 'in_transit'],
      ['inscan_at_hub', 'in_transit'],
      ['pickup_completed', 'accepted'],
      ['pickup_completed', 'accepted'],
      ['softdata_update', undefined],
      ['assigned_courier_partner', 'registered'],
      ['Pickup Awaited', 'registered'],
    ]);
    expect(result.events?.every(event => event.location === undefined)).toBe(true);
  });

  it('distinguishes explicit absence, a different waybill, a broken scan and a browser check', () => {
    expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(example, 'FLOW000000000000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking(example.replace('29 Oct 2026 13:10', '29 Nov 2026 25:10'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('posts the waybill as the only form field to the public tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({
      fetcher, userAgent: 'FLOW Test', trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER,
    });
    await expect(tracker.track({ number: number.toLowerCase() }, { budgetMs: 2_000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://www.flowpl.com/order-tracking/', expect.objectContaining({
      signal: expect.any(AbortSignal), method: 'POST', body: new URLSearchParams({ ref_num: number }),
    }));
  });
});

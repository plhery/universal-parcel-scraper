import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const example = fixture('example');

describe('Amanat Logistics guest tracking', () => {
  it('reads the 14 completed steps and the carrier’s current status', () => {
    const result = parseTracking(example, 'AM-0031-INV-062');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered to Delhi',
      last_update: null, weight_kg: 11496,
    });
    expect(result.last_update_local).toBeUndefined();
    expect(result.events).toHaveLength(14);
    expect(result.events?.[0]).toMatchObject({ description: 'Delivered to Delhi', stage: 'delivered' });
    expect(result.events?.[0]?.local_time).toBeUndefined();
    expect(result.events?.[8]).toMatchObject({ description: 'Reached Hairatan', local_time: '2026-09-23' });
    expect(result.events?.find((row) => row.description === 'Docs Created — Hairatan')?.stage).toBeUndefined();
  });

  it('retains a consistent current day and ignores later pending milestones', () => {
    const pending = '<li class="tk-step tk-pending"><h3 class="tk-title">15. Future step</h3></li>';
    const consistent = example.replaceAll('15 Sep 2026', '25 Sep 2026').replace('</ol>', pending + '</ol>');
    const result = parseTracking(consistent, 'RN-062');
    expect(result).toMatchObject({ canonical_tracking_number: 'AM-0031-INV-062', last_update_local: '2026-09-25' });
    expect(result.events).toHaveLength(14);
  });

  it('distinguishes explicit absence from a mismatch or browser check', () => {
    expect(() => parseTracking(fixture('not-found'), 'AM0031INV062'))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(example, 'AM-0000-INV-000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('<title>Just a moment...</title>', 'RN-062'))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it('restores the dashes for the published tracking format in the normal guest request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'am0031inv062' })).resolves.toMatchObject({ status: 'delivered' });
    const [url] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://www.amanatlogistics.com/tracking/orders?lang=en&code=AM-0031-INV-062');
  });
});

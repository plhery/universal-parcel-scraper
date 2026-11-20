import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const number = 'MBG-2026-000123';
const example = fixture('example');

describe('MBG-Africa guest tracking', () => {
  it('reads the matching consignment and seven completed milestones newest first', () => {
    const result = parseTracking(example, number);
    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'In Transit',
      last_update: null, last_update_local: '2026-09-02T07:00', expected_delivery: '2026-09-05',
      service_name: 'Multimodal', destination_country_name: 'Burundi',
    });
    expect(result.events).toHaveLength(7);
    expect(result.events?.map(({ stage }) => stage)).toEqual([
      'in_transit', 'customs', 'in_transit', 'in_transit', 'in_transit', 'accepted', 'registered',
    ]);
    expect(result.events?.[0]).toEqual({
      description: 'Road Transport', location: 'Kobero Border, Burundi', local_time: '2026-09-02T07:00',
      stage: 'in_transit', stage_source: 'explicit_mapping',
    });
    expect(result.events?.at(-1)).toMatchObject({ description: 'Booking Confirmed', local_time: '2026-07-28T09:00' });
  });

  it('separates a matching missing result from other replies', () => {
    expect(() => parseTracking(fixture('not-found'), 'INVALID')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseTracking(fixture('not-found'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseTracking(example, 'OTHER')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseTracking('<title>Just a moment...</title>', number))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseTracking(example.replace('02 Sep 2026 — 07:00', '31 Sep 2026 — 07:00'), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('restores the display separators on explicit selection and sends only the reference in English', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(example));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });
    await expect(tracker.track({ number: 'mbg2026000123' })).resolves.toMatchObject({ status: 'in_transit' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://mbg-africa.com/track.php?tn=' + number + '&lang=en');
    expect(init?.body).toBeUndefined();
  });
});

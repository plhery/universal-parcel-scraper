import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const provider = 'xanh-thl';
const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');

it('loads the anonymous guest form and returns the exact waybill with local scans', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(fixture('form.html')))
    .mockResolvedValueOnce(new Response(fixture('guest-form.js')))
    .mockResolvedValueOnce(new Response(fixture('found.json')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber(provider, number) });
  expect(fetcher).toHaveBeenNthCalledWith(2, new URL('https://xanhthl.com/wp-content/litespeed/js/062afc8e4e6030a842347b1228e8ba86.js?ver=787bf'), expect.any(Object));
  expect(fetcher).toHaveBeenNthCalledWith(3, 'https://xanhthl.com/wp-admin/admin-ajax.php', expect.objectContaining({
    method: 'POST', body: new URLSearchParams({ action: 'xanh_get_tracking', nonce: '001122aabb', code: number }),
  }));
  expect(result).toMatchObject({ status: 'in_transit', last_update_local: '2026-11-14T09:05' });
  expect(result.events).toHaveLength(2);
  expect(result.events?.[0]).toMatchObject({ stage: 'in_transit', location: 'PGD Hồ Chí Minh', local_time: '2026-11-14T09:05' });
  expect(result.events?.[1]).toMatchObject({ stage: 'accepted', local_time: '2026-11-14T08:49' });
});

it('handles the carrier’s zero-record sentinel and rejects mismatched waybills', () => {
  expect(() => parseTracking(fixture('missing.json'), 'X00000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('found.json'), 'X00000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

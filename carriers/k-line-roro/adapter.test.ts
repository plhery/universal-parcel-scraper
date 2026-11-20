import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseBooking, parseTracking } from './parser.js';

const bill = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('resolves the bill and keeps actual port movements at minute precision', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(fixture('suggestion')))
    .mockResolvedValueOnce(new Response(fixture('found')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('k-line-roro', bill) });
  expect(fetcher).toHaveBeenNthCalledWith(1, 'https://apps.klineglobalroro.com/tracking/api/suggestion?inputValue=' + bill, expect.any(Object));
  expect(fetcher).toHaveBeenNthCalledWith(2, 'https://apps.klineglobalroro.com/tracking/api/bl/KKLU/SOU012222/SOU012222', expect.any(Object));
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Actual Arrival', last_update_local: '2026-11-10T02:54' });
  expect(result.events).toHaveLength(2);
  expect(result.events?.[0]).toMatchObject({ description: 'Actual Arrival', location: 'BALTIMORE', local_time: '2026-11-10T02:54' });
  expect(result.events?.[1]).toMatchObject({ description: 'Actual Departure', location: 'SOUTHAMPTON', local_time: '2026-10-20T15:39' });
});

it('rejects a mismatch at either step and handles the carrier’s missing-bill reply', () => {
  const missing = 'KKLUZZZ000000';
  expect(() => parseBooking(fixture('missing'), missing, 400)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseBooking(fixture('suggestion'), missing, 200)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('found'), missing)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = readFileSync(new URL('./fixtures/in-transit.html', import.meta.url), 'utf8');

it('loads the numbered page and reads the distinct dated forwarding movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('flashpy', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.flashpy.com/co/tracking?code=' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    status: 'in_transit', current_stage: 'in_transit',
    last_status_text: 'Proceso Internacional', last_update_local: '2026-06-10T16:52',
  });
  expect(result.events?.map(event => [event.local_time, event.stage])).toEqual([
    ['2026-06-10T16:52', 'in_transit'],
    ['2026-06-10T14:21', 'in_transit'],
    ['2026-06-09T09:22', 'registered'],
    ['2026-06-06T12:45', 'registered'],
  ]);
});

it('requires the number printed by the result card', () => {
  expect(() => parseTracking(fixture, number + '-OTHER')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

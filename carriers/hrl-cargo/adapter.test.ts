import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const delivered = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');

it('submits the carrier form and preserves day-level branch movements', async () => {
  const page = '<form method="POST"><input type="hidden" name="$ACTION_ID_fixture" value=""><input name="docno"></form>';
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(page)).mockResolvedValueOnce(new Response(delivered));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('hrl-cargo', number) });
  expect(fetcher.mock.calls.map(args => args[0])).toEqual([
    'https://www.hrlcargo.com/track/', 'https://www.hrlcargo.com/track/',
  ]);
  const request = fetcher.mock.calls[1]?.[1];
  expect(request?.method).toBe('POST');
  expect([...request?.body as FormData]).toEqual([['$ACTION_ID_fixture', ''], ['docno', number]]);
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-10-20',
  });
  expect(result.events?.map(event => [event.description, event.local_time, event.location, event.stage])).toEqual([
    ['Delivered', '2026-10-20', 'BHOPAL', 'delivered'],
    ['Dispatched', '2026-10-19', 'INDORE', 'in_transit'],
    ['Booked', '2026-10-19', 'INDORE', 'registered'],
  ]);
});

it('requires the docket from the result card to match the request', () => {
  expect(() => parseTracking(delivered, number + '-OTHER')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

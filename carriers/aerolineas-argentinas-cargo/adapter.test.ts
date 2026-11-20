import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const html = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const empty = readFileSync(new URL('./fixtures/empty.html', import.meta.url), 'utf8');

it('splits the full air waybill and keeps both native milestone tables', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('aerolineas-argentinas-cargo', '044-33256462') });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://aerolineas.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix=044&AWBNo=33256462',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'Delivered at RGA', last_update_local: '2026-07-23T16:33',
  });
  expect(result.events?.map(event => [event.description, event.local_time, event.location, event.stage])).toEqual([
    ['Delivered', '2026-07-23T16:33', 'RGA', 'delivered'],
    ['Arrived', '2026-07-22T02:32', 'RGA', 'in_transit'],
    ['Departed', '2026-07-21T23:17', 'AEP', 'in_transit'],
    ['Accepted', '2026-07-21T14:13', 'AEP', 'accepted'],
    ['Booked', '2026-07-21T13:39', 'AEP', 'registered'],
  ]);
  expect(result.events?.some(event => event.time)).toBe(false);
});

it('requires a confirmed result heading rather than an echoed input field', () => {
  expect(() => parseTracking(html, '36348933')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(empty, '36348933')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('looks up the exact PRO and returns six carrier scans without appointment details', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('sun-logistics', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://tracking.carrierlogistics.com/scripts/snle.pol/facts.htm?startpage=protrace&pronum=' + number,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_update_local: '2026-03-11T11:32:00', last_status_text: 'Delivered',
  });
  expect(result.events?.map(event => [event.local_time, event.description, event.location, event.stage])).toEqual([
    ['2026-03-11T11:32:00', 'Delivered', 'JAMAICA, NY', 'delivered'],
    ['2026-03-11T07:43:00', 'Out For Delivery', undefined, 'out_for_delivery'],
    ['2026-03-10T09:30:00', 'Loaded On Trailer', undefined, 'in_transit'],
    ['2026-03-09T15:40:00', 'Appointment Set', undefined, undefined],
    ['2026-03-09T08:12:00', 'Scanned On Dock', 'Maspeth, NY', 'in_transit'],
    ['2026-03-07T03:30:00', 'Freight Unloaded', undefined, 'in_transit'],
  ]);
});

it('rejects an empty tracker and a response with a different shipment heading', () => {
  expect(() => parseTracking(fixture('empty-lookup'), number)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  const wrongResult = fixture('delivered').replace('Shipment number ' + number, 'Shipment number 00000000');
  expect(() => parseTracking(wrongResult, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

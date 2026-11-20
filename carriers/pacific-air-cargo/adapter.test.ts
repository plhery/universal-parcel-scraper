import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const html = readFileSync(new URL('./fixtures/in-transit.html', import.meta.url), 'utf8');

it('returns only confirmed flight events for the published Pacific Air Cargo waybill', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('pacific-air-cargo', '5YR-92203705') });

  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.pactracking.com/track/?AwbPrefix=5YR&awb=92203705',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Flight Arrived', last_update_local: '2022-05-05T04:59:00' });
  expect(result.events?.map(event => [event.description, event.local_time, event.location])).toEqual([
    ['Flight Arrived', '2022-05-05T04:59:00', 'HNL'],
    ['Flight Departed', '2022-05-05T03:21:00', 'LAX'],
    ['Shipment Received', '2022-05-04T12:57:57', 'LAX'],
  ]);
  expect(result.events?.some(event => event.time)).toBe(false);
});

it('requires a matching waybill in the carrier response', () => {
  expect(() => parseTracking(html, '92203706')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('keeps a partial pickup in transit and preserves a day-only complete recovery', () => {
  const pickup = html.replace('"PickDate": null', '"PickDate": "2022-05-07T00:00:00"');
  const partial = parseTracking(pickup.replace('"PiecesPickedUp": 0', '"PiecesPickedUp": 2'), '92203705');
  expect(partial.current_stage).toBe('in_transit');
  const complete = parseTracking(pickup.replace('"PiecesPickedUp": 0', '"PiecesPickedUp": 5'), '92203705');
  expect(complete).toMatchObject({ current_stage: 'delivered', last_update_local: '2022-05-07' });
});

import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import delivered from './fixtures/delivered.json' with { type: 'json' };
import missing from './fixtures/missing.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = delivered.trackingNumber;

it('submits the public lookup and preserves the warehouse-to-delivery history at day precision', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(delivered)));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('lisa-parcel', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://lisaparcel.com/api/tracking/lookup', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ tracking_id: number }),
  }));
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2025-10-21',
  });
  expect(result.events).toHaveLength(25);
  expect(result.events?.[0]).toEqual({
    description: 'Вручение адресату', location: 'Липецк 58', local_time: '2025-10-21',
    stage: 'delivered', stage_source: 'carrier_map',
  });
  expect(result.events).toContainEqual(expect.objectContaining({ description: 'Left US warehouse', local_time: '2025-10-05' }));
  expect(result.events?.every(event => /^\d{4}-\d{2}-\d{2}$/.test(event.local_time ?? ''))).toBe(true);
});

it('classifies only the carrier’s typed 404 as a missing shipment', () => {
  expect(() => parseTracking(JSON.stringify(missing), 'M283452', 404))
    .toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(JSON.stringify(delivered), 'M283452', 200))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

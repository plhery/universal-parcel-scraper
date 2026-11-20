import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const [newJersey, massachusetts, suffixed] = numbers.records.map(record => record.number);
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('looks up the exact PRO and combines identical delivery scans', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered-new-jersey')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('rist-transport', newJersey!) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://ltl-tracking.risttransport.com/boldetail.htm?nav=top&wbtn=PRO&wpro1=' + newJersey,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(result).toMatchObject({
    current_stage: 'delivered', last_status_text: 'DELIVERY COMPLETE', last_update_local: '2024-07-30T15:11:00',
  });
  expect(result.events?.map(event => [event.description, event.stage])).toEqual([
    ['Delivered', 'delivered'],
    ['Out For Delivery', 'out_for_delivery'],
    ['Manifested For Delivery', undefined],
    ['Picked Up', 'accepted'],
    ['Pickup Request Received', 'registered'],
  ]);
  expect(result.events?.[0]?.location).toBe('East Windsor, NJ');
});

it('recognizes a suffixed PRO and the legacy midnight-hour scan format', () => {
  expect(parseTracking(fixture('delivered-suffixed'), suffixed!)).toMatchObject({
    current_stage: 'delivered', last_update_local: '2023-03-15T11:38:00',
  });
  expect(parseTracking(fixture('delivered-massachusetts'), massachusetts!).events).toContainEqual(
    expect.objectContaining({ description: 'Manifested', local_time: '2023-04-13T00:09:00' }),
  );
});

it('handles the unnumbered tracking form and rejects a different shipment', () => {
  expect(() => parseTracking(fixture('empty-lookup'), newJersey!)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('delivered-massachusetts'), newJersey!)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const deliveredNumber = numbers.records[0]!.number;
const canceledNumber = numbers.records[1]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('requests the exact guide and keeps the delivery time and public movement history', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('jet-delivery', deliveredNumber) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.jetdelivery.com/api/v1/utilities/track/?idx=' + deliveredNumber,
    expect.any(Object),
  );
  expect(result).toMatchObject({
    status: 'delivered', last_status_text: 'Delivered', delivered_at: '2026-02-26T13:09:00-08:00',
  });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).toMatchObject({ stage: 'delivered', location: 'Brentwood, CA', time: '2026-02-26T13:09:00-08:00' });
  expect(result.events?.[1]).toMatchObject({ description: 'Driver departed from Los Angeles, CA' });
  expect(result.events?.[1]).not.toHaveProperty('stage');
});

it('reports the later cancellation without turning driver dispatch into parcel acceptance', () => {
  const result = parseTracking(fixture('canceled'), canceledNumber);
  expect(result).toMatchObject({ status: 'exception', last_status_text: 'Canceled', last_update: '2026-02-28T22:00:06-08:00' });
  expect(result.events).toHaveLength(3);
  expect(result.events?.[0]).toMatchObject({ stage: 'exception', description: 'Shipment acknowledged as canceled.' });
  expect(result.events?.[1]).not.toHaveProperty('stage');
  expect(result).not.toHaveProperty('delivered_at');
});

it('rejects mismatched shipments and recognizes the native invalid-number reply', () => {
  expect(() => parseTracking(fixture('delivered'), canceledNumber)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), '00000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
});

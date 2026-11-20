import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('posts one box number and reads its actual calendar-date movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('delivered')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('umac-cargo', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://umac-track.vercel.app/api/track', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ trackingNo: number }),
  }));
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered', last_update_local: '2025-10-20' });
  expect(result.events).toHaveLength(11);
  expect(result.events?.[1]).toMatchObject({ stage: 'out_for_delivery', local_time: '2025-10-20' });
  expect(result.events?.some(event => event.stage === 'customs')).toBe(true);
});

it('removes forecasts and lets the carrier resolve the current milestone on the same day', () => {
  const reply = JSON.parse(fixture('delivered'));
  const [delivered, outForDelivery] = reply.events;
  reply.events = [
    { ...delivered, timestamp: '2025-10-23T00:00:00.000Z', isETA: true },
    outForDelivery,
    delivered,
    ...reply.events.slice(2),
  ];
  const result = parseTracking(JSON.stringify(reply), number);
  expect(result).toMatchObject({ status: 'delivered', last_update_local: '2025-10-20' });
  expect(result.events).toHaveLength(11);
});

it('requires the exact box even on empty replies', () => {
  const missing = fixture('missing');
  expect(() => parseTracking(missing, 'UMTC350514')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(missing, number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(parseTracking(fixture('another-delivery'), numbers.records[1]!.number))
    .toMatchObject({ status: 'delivered', last_update_local: '2025-09-19' });
});

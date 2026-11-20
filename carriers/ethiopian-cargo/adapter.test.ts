import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;

it('posts the air waybill and retains actual scans for its separate groups of pieces', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(fixture('history')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://cargo.ethiopianairlines.com/my-cargo/track-your-shipment/Index/',
    expect.objectContaining({ method: 'POST', body: new URLSearchParams({ AirwayBilNum: number, CheckIn: '', CheckOut: '' }) }),
  );
  expect(result).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'Departed on Flight', last_update_local: '2018-03-27T19:13:00',
  });
  expect(result.events).toHaveLength(14);
  expect(result.events?.filter(event => event.local_time === '2018-03-24T20:31:00').map(event => event.description))
    .toEqual(['Manifested on Flight (5/112 Pcs)', 'Manifested on Flight (1/112 Pcs)']);
});

it('reads a dated carrier delivery and distinguishes a missing or different air waybill', () => {
  const serial = numbers.records[1]!.number.split('-')[1]!;
  expect(parseTracking(fixture('delivered'), serial)).toMatchObject({
    status: 'delivered', last_status_text: 'Delivered', last_update_local: '2021-02-19T14:06:00',
  });
  expect(() => parseTracking(fixture('delivered'), number.split('-')[1]!)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), '00000001')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('missing-with-serial'), '00000001')).toThrow(expect.objectContaining({ kind: 'not_found' }));
});

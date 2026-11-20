import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const number = numbers.records[0]!.number;
const [prefix, serial] = number.split('-') as [string, string];
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');
const history = fixture('history');

it('returns the exact air waybill with the carrier’s actual movement instants', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('airbaltic-cargo', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://cargotrack.airbaltic.com/?p=657&s=32006306', expect.any(Object));
  expect(result).toMatchObject({ status: 'delivered', last_status_text: 'Delivered', last_update: '2025-09-25T12:07:00.000Z' });
  expect(result.events).toHaveLength(14);
  expect(result.events?.[0]).toMatchObject({ time: '2025-09-25T12:07:00.000Z', location: 'IST', stage: 'delivered' });
  expect(result.events?.find(event => event.description === 'Received From Flight')).toMatchObject({
    time: '2025-09-21T13:10:00.000Z', location: 'IST', stage: 'in_transit',
  });
  expect(result.events?.find(event => event.description === 'Received From Shipper')).toMatchObject({
    time: '2025-09-18T22:54:00.000Z', location: 'BRU', stage: 'accepted',
  });
  expect(result.events?.filter(event => event.stage === 'registered')).toHaveLength(4);
  expect(result).not.toHaveProperty('expected_delivery');
});

it('rejects mismatched identities, invalid check digits and malformed pages', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: directTrackingNumber('airbaltic-cargo', '657-32006309') }))
    .rejects.toMatchObject({ kind: 'invalid_input' });
  expect(fetcher).not.toHaveBeenCalled();
  expect(() => parseTracking(fixture('missing'), prefix, '00000000')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history, prefix, '00000000')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking('<h1>Air waybill Nr. ' + number + '</h1>', prefix, serial))
    .toThrow(expect.objectContaining({ kind: 'schema' }));
});

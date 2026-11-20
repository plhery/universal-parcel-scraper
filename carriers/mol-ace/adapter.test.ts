import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const number = numbers.records[0]!.number;
const bill = number.slice(4);
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8');

it('submits the numeric bill and returns the completed port movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('found')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('mol-ace', number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://www.molace.com/TRK/SearchResult', expect.objectContaining({
    method: 'POST', body: new URLSearchParams({
      UserId: '0', SearchBy: 'BL', SearchString: bill, OrderAscDesc: 'ASC',
      OrderBy: 'VIN_NO', PageIndex: '1', PageSize: '15', HitSearch: 'Y',
    }),
  }));
  expect(result).toMatchObject({ status: 'in_transit', last_status_text: 'Actual Arrival', last_update_local: '2026-11-10T06:05' });
  expect(result.events).toHaveLength(2);
  expect(result.events?.[0]).toMatchObject({ description: 'Actual Arrival', location: 'NEWARK FAPS', local_time: '2026-11-10T06:05' });
  expect(result.events?.[1]).toMatchObject({ description: 'Actual Departure', location: 'YOK-DAIKOKU PCC', local_time: '2026-10-04T15:35' });
});

it('requires the exact bill and ignores dates without the completed styling', () => {
  expect(() => parseTracking(fixture('found'), '99999999999')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(fixture('missing'), '99999999999')).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('found').replaceAll('text-success', ''), bill))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

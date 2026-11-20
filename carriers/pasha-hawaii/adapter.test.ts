import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const [reefer, dry, retired, bill] = numbers.records;
const fixture = (name: string) => readFileSync(new URL('./fixtures/' + name + '.html', import.meta.url), 'utf8');

it('submits the exact equipment number and preserves separate loaded and empty movements', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('reefer')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('pasha-hawaii', reefer!.number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.pashahawaiishipping.com/cgi-pas/WEQ001.PGM',
    expect.objectContaining({ method: 'POST', body: new URLSearchParams({
      SCTYPE: 'EQ', SCREFN: reefer!.number, SCPRIN: 'PA',
    }) }),
  );
  expect(result).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'LOADED EMPTY ON VESSEL', last_update_local: '2026-11-17T01:26',
  });
  expect(result.events).toHaveLength(8);
  expect(result.events?.[0]).toMatchObject({ description: 'LOADED EMPTY ON VESSEL', location: 'HONOLULU, HI' });
  expect(result.events?.[1]).not.toHaveProperty('stage');
  expect(result.events?.[2]).toMatchObject({
    stage: 'delivered', description: 'DELIVERED FULL IMPORT', local_time: '2026-11-13T09:50',
  });
});

it('submits a qualified bill and retains the day-only port snapshot', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(fixture('bill-snapshot')));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('pasha-hawaii', 'PHWC' + bill!.number) });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    'https://www.pashahawaiishipping.com/cgi-pas/WCS001.PGM',
    expect.objectContaining({ method: 'POST', body: new URLSearchParams({
      SCTYPE: 'BL', SCREFN: bill!.number, SCPRIN: 'PA',
    }) }),
  );
  expect(result).toMatchObject({
    status: 'unknown', last_status_text: 'RETURN MTY TO TERMINAL', last_update_local: '2026-11-14',
    events: [{ description: 'RETURN MTY TO TERMINAL', local_time: '2026-11-14', location: 'HNL PIER 51A' }],
  });
  expect(result).not.toHaveProperty('current_stage');
});

it('requires the returned identity and leaves sales of equipment unmapped', () => {
  expect(() => parseTracking(fixture('dry'), reefer!.number, 'EQ'))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(parseTracking(fixture('dry'), dry!.number, 'EQ')).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'DISCHARGED EMPTY CONTAINER', last_update_local: '2026-10-26T19:49',
  });
  expect(parseTracking(fixture('retired'), retired!.number, 'EQ')).toMatchObject({
    status: 'unknown', last_status_text: 'SOLD', last_update_local: '2015-08-10T09:01',
  });
});

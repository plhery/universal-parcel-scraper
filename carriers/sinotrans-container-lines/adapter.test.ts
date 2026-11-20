import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseFormState, parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const number = numbers.records[0]!.number;
const found = fixture('container');
const portal = 'https://ebusiness.sinolines.com.cn/Ebusiness/EQUERY/TrackingCargoE.aspx?subject=BLNO';
const form = `
  <form id="form1">
    <input type="hidden" name="__VIEWSTATE" value="guest-state">
    <input type="hidden" name="__VIEWSTATEGENERATOR" value="generator">
    <select id="dl_seltype"><option value="cntrno">Container Number</option></select>
  </form>`;

it('submits the guest form and reads the exact container’s dated history', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(form))
    .mockImplementationOnce(async () => new Response(found));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenNthCalledWith(1, portal, expect.objectContaining({ headers: expect.any(Object) }));
  expect(fetcher).toHaveBeenNthCalledWith(2, portal, expect.objectContaining({ method: 'POST' }));
  expect(Object.fromEntries(fetcher.mock.calls[1]![1]!.body as URLSearchParams)).toEqual({
    __VIEWSTATE: 'guest-state',
    __VIEWSTATEGENERATOR: 'generator',
    dl_seltype: 'cntrno',
    TbBlno: number,
    CNTRNOTXT: '',
    BlnoListRetrieveBT: 'Search',
  });
  expect(result).toMatchObject({ status: 'unknown', last_status_text: 'OFF HIRE*', last_update_local: '2015-05-29T23:59:00' });
  expect(result.events).toHaveLength(50);
  expect(result.events?.[0]).toMatchObject({ description: 'OFF HIRE*', location: 'XINGANG' });
  expect(result.events?.[0]?.stage).toBeUndefined();
  expect(result.events?.find(event => event.description === 'ONLOAD*' && event.stage)).toMatchObject({ stage: 'in_transit' });
});

it('checks identity and validates the portal’s negative and challenge replies', () => {
  const invalid = 'ABCU0000000';
  expect(() => parseTracking(fixture('missing'), invalid)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(fixture('missing'), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  expect(() => parseTracking(found, invalid)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseFormState('<title>Just a moment</title>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
});

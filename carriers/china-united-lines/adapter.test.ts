import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseBooking, parseTracking } from './parser.js';
import numbers from './numbers.json' with { type: 'json' };

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const booking = fixture('booking');
const history = fixture('movements');
const number = numbers.records[0]!.number;

it('looks up the equipment booking and keeps its actual movements', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(booking))
    .mockImplementationOnce(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  const urls = fetcher.mock.calls.map(([input]) => new URL(input.toString()));
  expect(urls.map(url => url.searchParams.get('f_cmd'))).toEqual(['122', '125']);
  expect(urls.map(url => url.searchParams.get('cntr_no'))).toEqual([number, number]);
  expect(urls[1]?.searchParams.get('cop_no')).toBe(parseBooking(booking).copNo);
  expect(result).toMatchObject({
    status: 'in_transit', last_status_text: 'Empty Container Returned from Customer', last_update_local: '2023-06-13T14:10',
  });
  expect(result.events).toHaveLength(9);
  expect(result.events?.[0]).not.toHaveProperty('stage');
  expect(result.events?.[1]).toMatchObject({ provider_code: 'TDIMOF', location: 'NANSHA ,CHINA', stage: 'in_transit' });
});

it('distinguishes missing equipment, searches without actual rows, and different bookings', () => {
  const { copNo } = parseBooking(booking);
  expect(() => parseBooking(fixture('missing'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history.replaceAll('"actTpCd": "A"', '"actTpCd": "E"'), copNo))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(history, 'OTHER')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

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

it('follows the container booking and returns only actual, correctly bound events', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(booking))
    .mockImplementationOnce(async () => new Response(history));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

  const result = await tracker.track({ number });
  const requests = fetcher.mock.calls;
  expect(requests.map(([url]) => url)).toEqual(Array(2).fill('https://esvc.djship.co.kr/gnoss/CUP_HOM_3301GS.do'));
  expect(requests.map(([, init]) => Object.fromEntries(new URLSearchParams(init?.body?.toString())))).toEqual([
    { f_cmd: '122', cntr_no: number, cust_cd: '' },
    { f_cmd: '125', cntr_no: number, bkg_no: 'DJSREFERENCE01', cop_no: 'DJS00000000001' },
  ]);
  expect(result).toMatchObject({
    status: 'in_transit',
    last_status_text: "'EASLINE KWANGYANG 2644W' Departure from Port of Loading",
    last_update_local: '2026-11-12T05:48',
  });
  expect(result.events).toHaveLength(4);
  expect(result.events?.[0]).toMatchObject({ provider_code: 'VDLMOF', location: 'BUSAN ,KOREA', stage: 'in_transit' });
  expect(result.events?.[3]).not.toHaveProperty('stage');
});

it('distinguishes a guest miss, a schedule without actual events, and a different booking', () => {
  const { copNo } = parseBooking(booking);
  expect(() => parseBooking(fixture('missing'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
  expect(() => parseTracking(history.replaceAll('"actTpCd": "A"', '"actTpCd": "E"'), copNo))
    .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  expect(() => parseTracking(history, 'OTHER')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

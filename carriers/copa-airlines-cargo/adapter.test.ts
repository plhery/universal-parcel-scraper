import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = fixture('delivered');
const notFound = fixture('not-found');
const reference = '23061044093';

it('reads booking and flight milestones in station wall time and keeps the listed delivery', () => {
  const result = parseTracking(delivered, reference);
  expect(result).toMatchObject({
    status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered at JFK', weight_kg: 24,
    last_update: null, last_update_local: '2021-06-22T07:38:00',
  });
  expect(result.events?.map(event => [event.description, event.location, event.local_time])).toEqual([
    ['Departed', 'PTY', '2021-06-22T07:38:00'],
    ['Arrived', 'PTY', '2021-06-22T05:45:00'],
    ['Departed', 'GYE', '2021-06-22T03:36:00'],
    ['Accepted', 'GYE', '2021-06-21T23:16:00'],
    ['Booked', 'PTY', '2021-06-04T09:06:00'],
    ['Booked', 'GYE', '2021-06-04T09:06:00'],
  ]);
  expect(result.events?.every(event => event.time === undefined)).toBe(true);
});

it('falls back to the shipment panel when the waybill list gives no delivery', () => {
  expect(parseTracking(delivered.replace('>Delivered at JFK<', '><'), reference)).toMatchObject({
    current_stage: 'in_transit', last_status_text: 'Arrived at PTY',
  });
});

it('binds the not-found answer, another waybill, a verification page and changed columns', () => {
  expect(() => parseTracking(notFound, '23048271635')).toThrow(NotFoundError);
  expect(() => parseTracking(notFound, reference)).toThrow(SchemaError);
  expect(() => parseTracking(delivered, '23061044104')).toThrow(IndeterminateError);
  expect(() => parseTracking('<title>Just a moment...</title>', reference)).toThrow(ChallengeError);
  expect(() => parseTracking(delivered.replace('<th scope="col">Flight Date</th>', '<th scope="col">Flight</th>'), reference))
    .toThrow(SchemaError);
  expect(() => parseTracking(delivered.replace('<td>21/06/2021 23:16</td>', '<td>&nbsp;</td>'), reference)).toThrow(SchemaError);
});

it('opens the tracking link, follows its same-page redirect and validates the waybill first', async () => {
  const encrypted = 'https://copa.smartkargo.com/FrmAWBTracking.aspx?encrpt=1&AWBPrefix=demo-prefix&AWBNo=demo-serial';
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: encrypted.slice(27) } }))
    .mockResolvedValueOnce(new Response(delivered))
    .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://example.com/FrmAWBTracking.aspx?encrpt=1&AWBPrefix=a&AWBNo=b' } }));
  const instance = adapter({ fetcher, userAgent: 'Copa test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: '230-61044094' })).rejects.toThrow(InvalidInputError);
  await expect(instance.track({ number: '83811594284' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(instance.track({ number: ' 230-61044093 ' })).resolves.toMatchObject({ current_stage: 'delivered' });
  await expect(instance.track({ number: reference })).rejects.toThrow(SchemaError);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    'https://copa.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix=230&AWBNo=61044093', encrypted,
    'https://copa.smartkargo.com/FrmAWBTracking.aspx?AWBPrefix=230&AWBNo=61044093',
  ]);
  const init = fetcher.mock.calls[0]![1];
  expect(new Headers(init?.headers).get('User-Agent')).toBe('Copa test agent');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

it('parses a page served without a redirect', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(notFound));
  const instance = adapter({ fetcher, env: {}, recorder: NOOP_RECORDER, trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: '230-48271635' })).rejects.toThrow(NotFoundError);
});

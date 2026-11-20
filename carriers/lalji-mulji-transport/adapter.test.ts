import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import missing from './fixtures/not-found.json' with { type: 'json' };
import oldSarkhej from './fixtures/old-sarkhej.json' with { type: 'json' };
import sarkhej from './fixtures/sarkhej.json' with { type: 'json' };
import { parseTracking } from './parser.js';

const reference = '22175354';

it('keeps the depot arrival in transit and reads the branch, weight and India clocks', () => {
  const result = parseTracking(sarkhej, reference);
  expect(result).toMatchObject({
    current_stage: 'in_transit', current_stage_source: 'carrier_map',
    last_update: '2015-02-10T16:22:18+05:30', weight_kg: 1000,
  });
  expect(result.events?.map(event => [event.provider_code, event.stage, event.location])).toEqual([
    ['RECEIVED', 'in_transit', 'Old Sarkhej'],
    ['DISPATCHED', 'in_transit', 'SARKHEJ'],
    ['BOOKED', 'registered', 'TARAPUR'],
  ]);
  expect(result).not.toHaveProperty('delivered_at');
  expect(parseTracking(oldSarkhej, '22175325')).toMatchObject({ weight_kg: 1500, last_update: '2015-02-10T16:22:44+05:30' });
});

it('requires each returned movement to belong to the requested lorry receipt', () => {
  expect(() => parseTracking(sarkhej, '22175325')).toThrow(IndeterminateError);
  const mixed = { serviceResult: [...sarkhej.serviceResult, ...oldSarkhej.serviceResult] };
  expect(() => parseTracking(mixed, reference)).toThrow(IndeterminateError);
});

it('distinguishes the native missing response from an empty or malformed history', () => {
  expect(() => parseTracking(missing, '00000000')).toThrow(NotFoundError);
  expect(() => parseTracking({ serviceResult: [] }, reference)).toThrow(NoHistoryError);
  expect(() => parseTracking({ message: { messageId: 21 } }, reference)).toThrow(SchemaError);
  const row = { ...sarkhej.serviceResult[0], dateTime: 'bad time' };
  expect(() => parseTracking({ serviceResult: [row] }, reference)).toThrow(SchemaError);
});

it('sends the public tenant request with just the lorry receipt as lookup input', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(sarkhej))
    .mockResolvedValueOnce(new Response('<title>Just a moment</title>'));
  const instance = adapter({ fetcher, userAgent: 'Lalji Mulji test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: reference })).resolves.toMatchObject({ current_stage: 'in_transit' });
  const [request, init] = fetcher.mock.calls[0]!;
  const url = new URL(String(request));
  expect(url.origin + url.pathname).toBe('https://lmterp.com/ivcargo/getTrackStatusDetails.do');
  expect(Object.fromEntries(url.searchParams)).toEqual({ pageId: '340', eventId: '5', modulename: 'trackStatus',
    accountGroupId: '201', wayBillNumber: reference });
  expect(new Headers(init?.headers).get('User-Agent')).toBe('Lalji Mulji test agent');
  await expect(instance.track({ number: reference })).rejects.toThrow(ChallengeError);
});

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseStatus, verifyBooking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');

it('requires the browser booking page to identify the exact consignment', () => {
  expect(() => verifyBooking(fixture('001872527051-booking'), '001872527051')).not.toThrow();
  expect(() => verifyBooking(fixture('806703085971-booking'), '001872527051')).toThrow(IndeterminateError);
  expect(() => verifyBooking('<h2>Sign In</h2>', '001872527051')).toThrow(SchemaError);
});

it('keeps the delivery summary and the earlier consignment scans in local time', () => {
  const result = parseStatus(fixture('303240072994-status'));
  expect(result).toMatchObject({
    current_stage: 'delivered', current_stage_source: 'carrier_map', status: 'delivered',
    last_update: null, last_update_local: '2015-04-17T09:15:57',
    events: [
      { local_time: '2015-04-17T09:15:57', stage: 'delivered', provider_code: 'Delivered' },
      { local_time: '2015-04-16T14:51:01', stage: 'in_transit', provider_code: 'InTransit' },
      { local_time: '2015-04-16T13:44:51', stage: 'registered', provider_code: 'Scheduled for Pickup' },
    ],
  });
  expect(result.events?.[0]).not.toHaveProperty('time');
  expect(parseStatus(fixture('001872527051-status'))).toMatchObject({
    status: 'delivered', events: [{ local_time: '2022-04-11T11:30:00' }],
  });
});

it('preserves the transit summary after an earlier delivery row on the native page', () => {
  expect(parseStatus(fixture('819642999269-status'))).toMatchObject({
    status: 'in_transit', last_update_local: '2023-04-05T08:59:53',
    events: [{ stage: 'in_transit' }, { stage: 'delivered', local_time: '2023-04-05T08:58:59' }],
  });
});

it('distinguishes a verification response, changed markup and a recognized empty timeline', () => {
  expect(() => parseStatus('<title>Just a moment</title>')).toThrow(ChallengeError);
  expect(() => parseStatus('<p>Server Error</p>')).toThrow(SchemaError);
  expect(() => parseStatus('<div class="detail-wrapper"><label>Status</label></div>' +
    '<div class="detail-wrapper"><label>Consignment History</label></div>')).toThrow(NoHistoryError);
});

it('opens the booking and posts its exact reference to the empty-body status lookup', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(fixture('806703085971-booking')))
    .mockResolvedValueOnce(new Response(fixture('806703085971-status')));
  const instance = adapter({ fetcher, userAgent: 'Courierit test agent', env: {}, recorder: NOOP_RECORDER,
    trawl: null, browserExecutablePath: null });
  await expect(instance.track({ number: ' 806703085971 ' })).resolves.toMatchObject({
    status: 'delivered', last_update_local: '2023-06-28T06:30:05',
  });
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/Order/View', '/Order/OrderViewWithLatestStatus',
  ]);
  for (const [url, options] of fetcher.mock.calls) {
    expect(new URL(String(url)).searchParams.get('consignmentRef')).toBe('806703085971');
    expect(options?.redirect).toBe('error');
  }
  expect(fetcher.mock.calls[1]?.[1]?.method).toBe('POST');
  expect(String(fetcher.mock.calls[1]?.[1]?.body)).toBe('');
  await expect(instance.track({ number: '80670308' })).rejects.toThrow(InvalidInputError);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const delivered: unknown = JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const inTransit: unknown = JSON.parse(readFileSync(new URL('./fixtures/in-transit.json', import.meta.url), 'utf8'));

it('reads the exact published waybill through the public iCMS service', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(JSON.stringify(delivered)));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracker.track({ number: directTrackingNumber('garuda-indonesia-cargo', '126-90464441') });

  expect(fetcher).toHaveBeenCalledTimes(1);
  const [request] = fetcher.mock.calls[0]!;
  const url = new URL(String(request));
  expect(url.origin + url.pathname).toBe('https://icms.garuda-indonesia.com/Services/Shipment/AWBTrackingService.svc/GetAWBTrackingRecord');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    AWBNo: '90464441', BasedOn: '0', CarrierCode: '126', AccountSNo: '0', flag: '0', AWBTrackingCaptchaCode: '',
  });
  expect(result).toMatchObject({
    current_stage: 'delivered', provider_code: 'DLV', last_status_text: 'Delivered', last_update_local: '2025-11-30T11:49',
  });
  expect(result.events).toHaveLength(8);
  expect(result.events?.[0]).toMatchObject({ description: 'Delivered', location: 'CGK', local_time: '2025-11-30T11:49' });
  expect(result.events?.at(-1)).toMatchObject({ provider_code: 'BKD', stage: 'registered', location: 'SIN' });
});

it('preserves airport-clock order and keeps receipt from a flight in transit', () => {
  const result = parseTracking(inTransit, '87809422');
  expect(result).toMatchObject({
    current_stage: 'in_transit', provider_code: 'RCF', last_status_text: 'Received from flight', last_update_local: '2025-09-08T14:40',
  });
  const history = result.events ?? [];
  const firstDeparture = history.findIndex(event => event.location === 'DPS' && event.provider_code === 'DEP');
  const firstArrival = history.findIndex(event => event.location === 'CGK' && event.provider_code === 'ARR');
  expect(history[firstDeparture]).toMatchObject({ local_time: '2025-09-08T06:45' });
  expect(history[firstArrival]).toMatchObject({ local_time: '2025-09-08T05:45' });
  expect(firstArrival).toBeLessThan(firstDeparture);
  expect(history.some(event => event.time)).toBe(false);
});

it('requires a matching waybill before reading any events', () => {
  expect(() => parseTracking(delivered, '87809422')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
});

it('stops when the public service refuses the lookup', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('Access denied', { status: 403 }));
  const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  await expect(tracker.track({ number: '90464441' })).rejects.toMatchObject({ kind: 'challenge' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

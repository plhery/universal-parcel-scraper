import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { directTrackingNumber } from '../../core/adapter/track.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const parts = { 1: 'travel', 2: 'booking', 3: 'delivery' } as const;
const replies = (prefix: string) => ({
  travel: JSON.parse(fixture(`${prefix}-travel`)) as unknown,
  booking: JSON.parse(fixture(`${prefix}-booking`)) as unknown,
  delivery: JSON.parse(fixture(`${prefix}-delivery`)) as unknown,
});

/** The platform's three answers for a fixture prefix, by the purpose each request names. */
function serving(prefix: string) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const { purpose } = JSON.parse(String(init?.body)) as { purpose: keyof typeof parts };
    return new Response(fixture(`${prefix}-${parts[purpose]}`), { headers: { 'content-type': 'application/json' } });
  });
}

function tracker(fetcher: typeof fetch) {
  return adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
}

describe('Shree Nandan Courier', () => {
  it('asks the Connecting Nandan web view for the three parts of a shipment and returns its local history', async () => {
    const request = serving('1706262087963');
    const result = await tracker(request).track({ number: directTrackingNumber('shree-nandan', '1706262087963') });

    expect(request).toHaveBeenCalledTimes(3);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.connectingnandan.com/v1/utilities/tracking/web-view/1706262087963');
    expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'api-key': 'NANDAN_OPERATION_WEB_2022', 'app-id': '1', platform: 'WEB' }) });
    expect(request.mock.calls.map(([, sent]) => JSON.parse(String(sent?.body)))).toEqual(['1', '2', '3'].map((purpose) => ({
      con_no: '1706262087963', purpose, is_external_tracking: 1,
    })));

    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered', last_update_local: '2026-10-26',
      service_name: 'NON DOX BY SURFACE', receiver_name: 'AK DUDHATRA', receiver_address: 'BHARUCH',
    });
    expect(result.events?.map((event) => [event.local_time, event.description, event.location, event.stage])).toEqual([
      ['2026-10-26', 'Delivered', 'BHARUCH', 'delivered'],
      ['2026-10-26T10:33:24', 'Shipment Reached at BHARUCH', 'BHARUCH', 'in_transit'],
      ['2026-10-26T04:11:46', 'Shipment Forwarded from SURAT HUB To BHARUCH', 'SURAT HUB', 'in_transit'],
      ['2026-10-25T16:28:08', 'Shipment Forwarded from AHMEDABAD HUB To SURAT HUB', 'AHMEDABAD HUB', 'in_transit'],
      ['2026-10-25T16:25:46', 'Shipment Reached at AHMEDABAD HUB', 'AHMEDABAD HUB', 'in_transit'],
      ['2026-10-25T01:32:22', 'Shipment Forwarded from RAJKOT HUB To AHMEDABAD HUB', 'RAJKOT HUB', 'in_transit'],
      ['2026-10-24T15:45:17', 'Booked', 'RAJKOT - MAVDI', 'accepted'],
    ]);
    expect(result.events?.every((event) => event.time === undefined)).toBe(true);
  });

  it('keeps the booking\'s delivered status over scans written after the delivery, and same-clock rows in order', () => {
    const result = parseTracking(replies('6538262000059'), '6538262000059');
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update_local: '2026-10-05T10:54:31', receiver_address: 'AHMEDABAD' });
    expect(result).not.toHaveProperty('receiver_name');
    expect(result.events?.map((event) => [event.local_time, event.description])).toEqual([
      ['2026-10-05T10:54:31', 'Shipment Reached at SURAT HUB'],
      ['2026-10-03', 'Delivered'],
      ['2026-10-03T13:11:13', 'Shipment Reached at SURAT HUB'],
      ['2026-10-03T02:00:57', 'Shipment Reached at SURAT - HUB'],
      ['2026-10-02', 'Delivered'],
      ['2026-10-02T14:45:24', 'Shipment Reached at SURAT - PARVAT PATIYA'],
      ['2026-10-02T14:45:07', 'Shipment Forwarded from SURAT HUB To SURAT - PARVAT PATIYA'],
      ['2026-10-01T11:42:07', 'Shipment Reached at SURAT HUB'],
      ['2026-09-30T23:03:32', 'Shipment Forwarded from AHMEDABAD HUB To SURAT HUB'],
      ['2026-09-30T23:02:31', 'Shipment Reached at AHMEDABAD HUB'],
      ['2026-09-29T22:13:41', 'Shipment Forwarded from DELHI KAROL BAGH HUB To DELHI AIRPORT HUB'],
      ['2026-09-29T22:13:33', 'Shipment Reached at DELHI KAROL BAGH HUB'],
      ['2026-09-29T22:13:33', 'Booked'],
    ]);
  });

  it('refuses an answer for another number', () => {
    expect(() => parseTracking(replies('1706262087963'), '6538262000059')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = { ...replies('1706262087963'), booking: JSON.parse(fixture('6538262000059-booking')) as unknown };
    expect(() => parseTracking(mixed, '1706262087963')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the tracker\'s empty answer as not found', async () => {
    await expect(tracker(serving('not-found')).track({ number: '9071530048612' }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads the notice for a shipment past the tracker\'s 180 days as expired history', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(fixture('history-expired'), { status: 423 }));
    await expect(tracker(request).track({ number: '1653252004446' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'history_expired' });
  });

  it('keeps a block page, a malformed reply and a rate limit apart from a missing parcel', async () => {
    const page = vi.fn<typeof fetch>(async () => new Response('<html><title>Just a moment...</title></html>', { status: 200 }));
    await expect(tracker(page).track({ number: '1706262087963' })).rejects.toMatchObject({ kind: 'challenge' });
    const broken = vi.fn<typeof fetch>(async () => new Response('{"STATUS":', { status: 200 }));
    await expect(tracker(broken).track({ number: '1706262087963' })).rejects.toMatchObject({ kind: 'schema' });
    const bare = vi.fn<typeof fetch>(async () => new Response('{"STATUS":{"NOTIFICATION":[""]}}', { status: 200 }));
    await expect(tracker(bare).track({ number: '1706262087963' })).rejects.toMatchObject({ kind: 'schema' });
    const limited = vi.fn<typeof fetch>(async () => new Response('', { status: 429 }));
    await expect(tracker(limited).track({ number: '1706262087963' })).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('does not read a number the platform holds without a booking as a shipment', () => {
    const empty = replies('not-found');
    const booking = { view: { con_no: '9071530048612', booking: { con_no: '9071530048612', center: 'SOME CENTER', bk_date: null, bk_status: null } } };
    expect(() => parseTracking({ ...empty, booking }, '9071530048612')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a number of another shape before any request', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(tracker(request).track({ number: '12345' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(request).not.toHaveBeenCalled();
  });
});

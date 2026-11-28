import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { bookingReference, normalizeEmiratesSkyCargoNumber, parseEmiratesSkyCargo } from './parser.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
// Public replies for 176-27246796 and 176-80060923.
const delivered = fixture('delivered.json');
const search = fixture('search.json');
const notFound = fixture('not-found.json');
const WAYBILL = '17627246796';
const signIn = () => Response.json({ access_token: 'guest-token-for-tests-only', token_type: 'bearer', expires_in: 899 });
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

type Booking = { data: { orderItems: { orderItem: { productInfo: { airCapacity: { destination: { code: string } } }; fulfillmentInfo: { serviceInfo: { milestone: unknown[] } } }[] } } };
const withMilestones = (from: number, destination?: string): Booking => {
  const data = structuredClone(delivered) as Booking;
  const item = data.data.orderItems.orderItem[0]!;
  item.fulfillmentInfo.serviceInfo.milestone = item.fulfillmentInfo.serviceInfo.milestone.slice(from);
  if (destination) item.productInfo.airCapacity.destination.code = destination;
  return data;
};

describe('Emirates SkyCargo air waybills', () => {
  it('takes the 176 prefix with or without a separator, or the serial alone, and checks its digit', () => {
    expect(normalizeEmiratesSkyCargoNumber('176-12345675')).toBe('17612345675');
    expect(normalizeEmiratesSkyCargoNumber('176 12345675')).toBe('17612345675');
    expect(normalizeEmiratesSkyCargoNumber('17612345675')).toBe('17612345675');
    expect(normalizeEmiratesSkyCargoNumber('12345675')).toBe('17612345675');
    expect(() => normalizeEmiratesSkyCargoNumber('176-12345676')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeEmiratesSkyCargoNumber('020-12345675')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('signs in as the guest client, finds the waybill’s booking and reads its delivery', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(signIn())
      .mockResolvedValueOnce(Response.json(search))
      .mockResolvedValueOnce(Response.json(delivered));
    const result = await tracker(fetcher).track({ number: '176-27246796' });

    expect(fetcher).toHaveBeenCalledTimes(3);
    const [[tokenUrl, tokenInit], [searchUrl, searchInit], [bookingUrl, bookingInit]] = fetcher.mock.calls as [string, RequestInit][];
    expect(tokenUrl).toBe('https://eskycargo.emirates.com/api/uaa/guest/oauth/token?productName=offerandorder');
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit.body)))).toEqual({ tenant: 'EK', client_id: 'mercator', client_secret: '' });
    expect(searchUrl).toBe('https://eskycargo.emirates.com/api/order/services/cargo/v1/orders/actions/search?view=summary');
    expect(new Headers(searchInit.headers).get('authorization')).toBe('Bearer guest-token-for-tests-only');
    expect(JSON.parse(String(searchInit.body))).toMatchObject({ orderFilter: { airCapacity: { documentNumbers: [WAYBILL] } } });
    expect(bookingUrl).toBe('https://eskycargo.emirates.com/api/order/services/cargo/v1/orders/b65713370');
    expect(new Headers(bookingInit.headers).get('authorization')).toBe('Bearer guest-token-for-tests-only');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: 'DLV', last_status_text: 'Delivered to the Consignee',
      last_update: null, last_update_local: '2026-11-19T11:10',
    });
  });

  it('keeps each station’s wall clock, Emirates’ own sequence and the flights in the wording', () => {
    const { events = [] } = parseEmiratesSkyCargo(delivered, WAYBILL);
    expect(events).toHaveLength(19);
    expect(events[0]).toMatchObject({ provider_code: 'DLV', location: 'JNB', local_time: '2026-11-19T11:10', stage: 'delivered' });
    expect(events.some(event => event.time)).toBe(false);
    expect(events.find(event => event.provider_code === 'DEP')).toMatchObject({
      description: 'Departed to JNB on Flight EK-0765, 29 Jun 2026, DXB-JNB', location: 'DXB', local_time: '2026-06-29T14:22', stage: 'in_transit',
    });
    expect(events.find(event => event.provider_code === 'NFD')).toMatchObject({
      description: 'Agent has been Notified of arrival of Shipment at JNB', stage: 'ready_for_pickup',
    });
    expect(events.find(event => event.provider_code === 'MAN')).not.toHaveProperty('stage');
    // Alicante's manifest came in after the flight left; the reply keeps it after the departure.
    expect(events.slice(13, 15).map(event => [event.provider_code, event.location, event.local_time])).toEqual([
      ['DEP', 'ALC', '2026-06-26T15:58'], ['MAN', 'ALC', '2026-06-27T02:28'],
    ]);
    expect(events.at(-1)).toMatchObject({ provider_code: 'BKD', location: 'MAD', stage: 'registered' });
  });

  it('reads the latest step that has a stage while the goods travel, and a notice away from the destination as a step on the way', () => {
    expect(parseEmiratesSkyCargo(withMilestones(5), WAYBILL)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', provider_code: 'DEP', last_update_local: '2026-06-29T14:22',
    });
    expect(parseEmiratesSkyCargo(withMilestones(6), WAYBILL)).toMatchObject({ provider_code: 'RCF', current_stage: 'in_transit' });
    expect(parseEmiratesSkyCargo(withMilestones(1), WAYBILL)).toMatchObject({ provider_code: 'NFD', current_stage: 'ready_for_pickup' });
    expect(parseEmiratesSkyCargo(withMilestones(1, 'CPT'), WAYBILL)).toMatchObject({ provider_code: 'NFD', current_stage: 'in_transit' });
  });

  it('requires the requested waybill in the search and the booking', () => {
    expect(bookingReference(search, WAYBILL)).toBe('65713370');
    expect(() => bookingReference(search, '17663344960')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseEmiratesSkyCargo(delivered, '17663344960')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports the search’s answer for a waybill without a booking as not found', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(signIn())
      .mockResolvedValueOnce(Response.json(notFound, { status: 404 }));
    await expect(tracker(fetcher).track({ number: '176-80060923' })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not take a refusal, a rate limit, a moved service or an unreadable reply for a missing waybill', async () => {
    const run = (...replies: Response[]) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const reply of replies) fetcher.mockResolvedValueOnce(reply);
      return tracker(fetcher).track({ number: WAYBILL });
    };
    await expect(run(new Response('<html><title>Access Denied</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(run(Response.json({ error: 'unauthorized' }, { status: 401 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(run(Response.json({ token_type: 'bearer' }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(run(signIn(), new Response('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(run(signIn(), new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'schema' });
    await expect(run(signIn(), Response.json({ status: 'failure', errors: [{ error_code: 'SERVICE_DOWN' }] }, { status: 404 })))
      .rejects.toMatchObject({ kind: 'schema' });
    await expect(run(signIn(), Response.json(search), new Response('<html></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(run(signIn(), Response.json(search), new Response('', { status: 404 }))).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('reads a booking without milestones as known without history', () => {
    expect(() => parseEmiratesSkyCargo(withMilestones(19), WAYBILL)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });
});

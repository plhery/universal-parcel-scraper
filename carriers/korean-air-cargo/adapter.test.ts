import { readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, guestSession, trackRequest } from './adapter.js';
import { normalizeKoreanAirCargoNumber, parseKoreanAirCargoTracking } from './parser.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// A synthetic reply on the fields the tracker's script reads; the not-found reply is live.
const delivered: unknown = JSON.parse(fixture('delivered.json'));
const sessionId = 'guest,session.for-the-korean-air-tests';
const page = (id = sessionId) => new Response(`<script>var drupalSettings = {"user":{"session_id":"${id}","region":"Europe"}};</script>`, {
  headers: [
    ['Content-Type', 'text/html; charset=UTF-8'],
    ['Set-Cookie', `SSESSdrupal=${id}; path=/; domain=.cargo.koreanair.com; secure; HttpOnly`],
    ['Set-Cookie', 'Authorization=guest-token; path=/; secure; HttpOnly'],
    ['Set-Cookie', 'bm_s=akamai-cookie; Domain=.koreanair.com; Path=/; Secure; HttpOnly'],
  ],
});
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Korean Air Cargo air waybills', () => {
  it('takes the 180 prefix with or without separators, or the serial alone', () => {
    expect(normalizeKoreanAirCargoNumber('180-33544873')).toBe('18033544873');
    expect(normalizeKoreanAirCargoNumber('180-3354 4873')).toBe('18033544873');
    expect(normalizeKoreanAirCargoNumber('18033544873')).toBe('18033544873');
    expect(normalizeKoreanAirCargoNumber('33544873')).toBe('18033544873');
    expect(() => normalizeKoreanAirCargoNumber('180-33544874')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeKoreanAirCargoNumber('080-33544873')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('opens the page’s guest session, then asks for the whole waybill with it', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(Response.json(delivered));
    const result = await tracker(fetcher).track({ number: '180-12345675' });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://cargo.koreanair.com/en/tracking');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(String(url)).toBe('https://cargo.koreanair.com/cargoportal/services/trackawb');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('cookie'))
      .toBe(`SSESSdrupal=${sessionId}; Authorization=guest-token; bm_s=akamai-cookie`);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      payLoad: [{ awbPrefix: '180', awbDocNo: '12345675' }],
      generalInfo: { sessionId, lang: 'EN' },
      userInfo: { region: 'Korea', userType: 'GUEST' },
    });
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', provider_code: 'DLV', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-11-22T03:15',
    });
  });

  it('writes the request time on Seoul’s clock as the script does', () => {
    const body = JSON.parse(trackRequest('18012345675', sessionId, DateTime.fromISO('2026-11-28T05:07:00Z')));
    expect(body.generalInfo.time).toBe('28 Nov 2026 14:7');
    expect(body.generalInfo.txnId).toMatch(/^[a-z0-9]+1795842420000$/);
  });

  it('keeps each station’s wall clock and orders the statuses by their UTC clocks', () => {
    const { events = [] } = parseKoreanAirCargoTracking(delivered, '18012345675');
    expect(events[0]).toMatchObject({ provider_code: 'DLV', location: 'DFW', local_time: '2026-11-22T03:15', stage: 'delivered' });
    const departure = events.findIndex(event => event.provider_code === 'DEP');
    const arrival = events.findIndex(event => event.provider_code === 'ARR');
    // Dallas's arrival clock reads earlier than Seoul's departure clock, but came later.
    expect(events[arrival]!.local_time! < events[departure]!.local_time!).toBe(true);
    expect(arrival).toBeLessThan(departure);
    expect(events[departure]).toMatchObject({ location: 'ICN', description: 'Departed', stage: 'in_transit' });
    expect(events.at(-1)).toMatchObject({ provider_code: 'BKD', description: 'Booking Confirmed', stage: 'registered' });
    expect(events.filter(event => event.provider_code === 'BKD')).toHaveLength(1);
    expect(events.some(event => event.time)).toBe(false);
  });

  it('falls back to the wall clocks when a status has no UTC clock', () => {
    const copy = JSON.parse(fixture('delivered.json'));
    for (const row of copy.payLoad[0].eventDetails) delete row.eventDateTimeUTC;
    const { events = [] } = parseKoreanAirCargoTracking(copy, '18012345675');
    expect(events.map(event => event.local_time)).toEqual([...events.map(event => event.local_time)].sort().reverse());
  });

  it('keeps a delivery current when a status comes after it', () => {
    const copy = JSON.parse(fixture('delivered.json'));
    copy.payLoad[0].eventDetails.push({
      eventCode: 'DIS', eventDesc: 'Discrepancy', arpCode: 'DFW', eventDate: '23 Nov 2026 10:00', eventDateTimeUTC: '23 Nov 2026 16:00',
    });
    const result = parseKoreanAirCargoTracking(copy, '18012345675');
    expect(result.events?.[0]).toMatchObject({ provider_code: 'DIS', description: 'Discrepancy' });
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'delivered', provider_code: 'DLV' });
  });

  it('requires the requested waybill before reading its history', () => {
    expect(() => parseKoreanAirCargoTracking(delivered, '18033544873')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reports a waybill Korean Air has no tracking data for as not found', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(new Response(fixture('not-found.json'), { headers: { 'Content-Type': 'application/json' } }));
    await expect(tracker(fetcher).track({ number: '180-33544873' })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('does not take a refused session or a verification page for a missing waybill', async () => {
    const expired = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(Response.json({
        generalInfo: { sessionId, time: '28 Nov 2026 14:31', txnId: '' },
        messages: [{ type: 'ERROR', code: 'ESC401', text: 'Session Expired. Please reload the page and proceed.' }],
      }));
    await expect(tracker(expired).track({ number: '180-33544873' }))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'session_rejected' });
    const invalid = { messages: [{ type: 'ERROR', code: 'ESC504', text: 'Invalid value.' }] };
    expect(() => parseKoreanAirCargoTracking(invalid, '18033544873')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('<html><head><title>Access Denied</title></head></html>', { status: 403 }));
    await expect(tracker(challenged).track({ number: '180-33544873' })).rejects.toMatchObject({ kind: 'challenge' });
    expect(challenged).toHaveBeenCalledTimes(1);
    expect(() => guestSession('<title>Access Denied</title>', [])).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => guestSession('<html></html>', [])).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'session_rejected' }));
  });
});

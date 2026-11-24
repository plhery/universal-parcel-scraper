import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusGapNote } from '../../core/status/statusMap.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { dateLocalClocks } from '../../places/index.js';
import { adapter, EMIRATES_COURIER_API, emiratesCourierLookupUrl } from './adapter.js';
import { normalizeEmiratesCourierNumber, parseEmiratesCourier } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's number, and an invented one of the same shape.
const NUMBER = '310100641953', UNKNOWN = '999999999990';

type Scan = Record<string, unknown> & { piece: Record<string, unknown> };
type Reply = Record<string, unknown> & { details: Scan[]; pieces: Record<string, unknown>[] };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
/** The sample's reply with its fields and its scans changed. */
const edit = (change: Record<string, unknown> = {}, scans?: (details: Scan[]) => Scan[]): Reply => {
  const reply = fixture('delivered');
  return { ...reply, ...change, details: scans ? scans(reply.details) : reply.details };
};
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Emirates Courier Express numbers', () => {
  it('takes the twelve digits, without the spaces or dashes a label prints', () => {
    expect(normalizeEmiratesCourierNumber(' 3101 0064-1953 ')).toBe(NUMBER);
    for (const other of ['', '31010064195', '3101006419530', 'A10100641953', '176-12345675']) {
      expect(() => normalizeEmiratesCourierNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('is not detected: twelve digits name no carrier on their own', () => {
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('emirates-courier-express');
  });
});

describe('Emirates Courier Express tracking adapter', () => {
  it('asks the API as the tracking-details page does, from the site, without a session', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: '3101 0064 1953' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.emiratescx.com/consumer/api/Tracking/v3/EcomTracking/${NUMBER}/en-US/view-details`);
    expect(emiratesCourierLookupUrl(NUMBER)).toBe(`${EMIRATES_COURIER_API}/${NUMBER}/en-US/view-details`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({
      Accept: 'application/json', Origin: 'https://www.emiratescx.com', Referer: 'https://www.emiratescx.com/' }) });
    const headers = new Headers(init!.headers);
    expect(headers.has('cookie') || headers.has('authorization')).toBe(false);
    expect(carrier(fetcher)).toMatchObject({ id: 'emirates-courier-express', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the empty reply for a number it holds nothing for as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(fixture('not-found')));
    await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseEmiratesCourier(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('keeps refusals, block pages, error pages and redirects apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: UNKNOWN }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
    expect(await answer(() => json({ message: 'Too many requests' }, { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Access Denied</title>', 403))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h2>The request is blocked.</h2>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({ message: 'Forbidden' }, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => json({ message: 'User not authenticated.' }, { status: 401 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<h1>Not Found</h1>', 404))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://www.emiratescx.com/maintainance' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html><body>Service Unavailable</body></html>', 503))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('<html></html>'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => new Response('{', { headers: { 'Content-Type': 'application/json' } }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => json({}))).toMatchObject({ kind: 'schema' });
  });
});

describe('Emirates Courier Express replies', () => {
  it('reads the sample: courier scans on the offset the reply states, flights on their wall clocks', () => {
    const result = parseEmiratesCourier(fixture('delivered'), NUMBER);
    const events = result.events ?? [];
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Shipment delivered',
      last_update: '2026-04-13T14:57:00+03:00', delivered_at: '2026-04-13T14:57:00+03:00', expected_delivery: null, destination_country: 'SA',
    });
    // A delivered parcel's estimate is a day after the request, so it is not named as unread.
    expect(result.unread_estimates).toBeUndefined();
    // The repeated arrivals at Riyadh and Dubai are kept once.
    expect(events).toHaveLength(16);
    expect(events[0]).toEqual({ time: '2026-04-13T14:57:00+03:00', description: 'Shipment delivered', location: 'RIYADH, SAUDI ARABIA',
      provider_code: 'DEL', stage: 'delivered', stage_source: 'carrier_map' });
    expect(events.find((event) => event.provider_code === 'DLXREFO')).toEqual({ time: '2026-04-09T18:06:00+03:00', description: 'Refused Other',
      location: 'RIYADH, SAUDI ARABIA', provider_code: 'DLXREFO', stage: 'exception', stage_source: 'carrier_map' });
    // A flight's message is written minutes after its clock, so the scan keeps the wall clock alone.
    expect(events.filter((event) => event.local_time).map((event) => [event.provider_code, event.local_time, event.location])).toEqual([
      ['DLV', '2026-04-08T22:50:00', 'King Khalid International Airp, Riyadh, SAUDI ARABIA'],
      ['ARR', '2026-04-08T17:46:00', 'King Khalid International Airp, Riyadh, SAUDI ARABIA'],
      ['ARR', '2026-04-08T16:13:00', 'King Khalid International Airp, Riyadh, SAUDI ARABIA'],
      ['DEP', '2026-04-08T14:30:00', 'Dubai International Airport, Dubai, UNITED ARAB EMIRATES'],
      ['ARR', '2026-04-08T09:28:00', 'Dubai International Airport, Dubai, UNITED ARAB EMIRATES'],
      ['DEP', '2026-04-07T22:47:00', 'Manchester Airport, Manchester, UNITED KINGDOM'],
    ]);
    expect(events.at(-1)).toEqual({ time: '2026-04-04T12:14:20+01:00', description: 'Shipment created', location: 'Manchester, UNITED KINGDOM',
      provider_code: 'SHC', stage: 'registered', stage_source: 'carrier_map' });
    expect(events.every((event) => event.stage_source === 'carrier_map')).toBe(true);
    // The origin town and the proof of delivery's fields stay behind.
    expect(JSON.stringify(result)).not.toMatch(/Bromborough|fileurl|Signature|lifeCycle/i);
  });

  it('dates the flights on the clock of their airport', () => {
    const dated = dateLocalClocks('emirates-courier-express', parseEmiratesCourier(fixture('delivered'), NUMBER));
    const zones = (dated.events ?? []).filter((event) => event.local_time).map((event) => [event.provider_code, event.time, event.time_zone]);
    expect(zones).toEqual([
      ['DLV', '2026-04-08T22:50:00+03:00', 'Asia/Riyadh'], ['ARR', '2026-04-08T17:46:00+03:00', 'Asia/Riyadh'],
      ['ARR', '2026-04-08T16:13:00+03:00', 'Asia/Riyadh'], ['DEP', '2026-04-08T14:30:00+04:00', 'Asia/Dubai'],
      ['ARR', '2026-04-08T09:28:00+04:00', 'Asia/Dubai'], ['DEP', '2026-04-07T22:47:00+01:00', 'Europe/London'],
    ]);
  });

  it('keeps a stated offset only on a quarter hour the scan’s country keeps', () => {
    const scan = (change: Record<string, unknown>) => (details: Scan[]) => [{ ...details[0]!, ...change }, ...details.slice(1)];
    const first = (reply: Reply) => parseEmiratesCourier(reply, NUMBER).events![0]!;
    // Saudi Arabia keeps UTC+03:00, not UTC+02:00.
    expect(first(edit({}, scan({ eventUtc: '2026-04-13T12:57:00Z' })))).toMatchObject({ local_time: '2026-04-13T14:57:00' });
    expect(first(edit({}, scan({ eventUtc: '2026-04-13T11:57:02Z' })))).toMatchObject({ local_time: '2026-04-13T14:57:00' });
    expect(first(edit({}, scan({ eventUtc: null })))).toMatchObject({ local_time: '2026-04-13T14:57:00' });
    expect(first(edit({}, scan({ eventUtc: '2026-04-13T11:57:00.4Z' })))).toMatchObject({ time: '2026-04-13T14:57:00+03:00' });
    // A place without a country is not checked.
    expect(first(edit({}, scan({ currentCountry: 'Somewhere', eventUtc: '2026-04-13T12:57:00Z' })))).toMatchObject({ time: '2026-04-13T14:57:00+02:00', location: 'Somewhere' });
  });

  it('names the estimate as unread while the parcel is on its way', () => {
    const result = parseEmiratesCourier(edit({}, (details) => details.slice(1)), NUMBER);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery',
      unread_estimates: ['estimatedDelivery', 'estimatedDeliveryDate'] });
    expect(result.delivered_at).toBeUndefined();
  });

  it('reads an exception by its group when the map does not know its reason, and a notice as moving nothing', () => {
    const reason = (code: string | null, pieceException: string | null, description = 'Something') => parseEmiratesCourier(edit({}, (details) => [
      { ...details[3]!, descriptionCode: code, description, piece: { ...details[3]!.piece, pieceException } }, ...details.slice(4)]), NUMBER);
    expect(reason('DLX', 'ZZZZ').events![0]).toMatchObject({ provider_code: 'DLXZZZZ', stage: 'exception', stage_source: 'carrier_map' });
    expect(reason('DLX', 'NDCN', 'Not Delivered Customer Not Available')).toMatchObject({ current_stage: 'failed_attempt' });
    expect(reason('OFD', 'REFO', 'Shipment out for delivery').events![0]).toMatchObject({ provider_code: 'OFD', stage: 'out_for_delivery' });
    const notice = reason('PWK', null, 'The required paperwork for your shipment has been uploaded');
    expect(notice.events![0]!.stage).toBeUndefined();
    // The notice keeps the stage of the scan before it, the out for delivery after the refusal.
    expect(notice).toMatchObject({ current_stage: 'out_for_delivery' });
    expect(reason(null, null, 'Shipment delivered').events![0]).toMatchObject({ stage: 'delivered', stage_source: 'wording:language' });
  });

  it('refuses another parcel’s reply', () => {
    const other = '310100641954';
    expect(() => parseEmiratesCourier(fixture('delivered'), other)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const reply = fixture('delivered');
    expect(() => parseEmiratesCourier({ ...reply, pieces: [{ ...reply.pieces[0], awbnumber: other }] }, NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a changed reply', () => {
    const scan = (change: Record<string, unknown>) => (details: Scan[]) => [{ ...details[0]!, ...change }, ...details.slice(1)];
    const unnamed = (details: Scan[]) => details.map((detail) => ({ ...detail, piece: { ...detail.piece, awbnumber: null } }));
    for (const reply of [null, [], {}, { details: null }, { ...fixture('delivered'), details: {} }, edit({ pieces: 'x' }),
      edit({}, () => []), { ...fixture('not-found'), origin: 'Bromborough, GB' },
      edit({}, scan({ d: '2026-04-13 14:57' })), edit({}, scan({ d: '2026-02-30T14:57:00' })), edit({}, scan({ eventUtc: '2026-04-13T11:57:00' })),
      edit({}, scan({ description: null })), edit({}, scan({ descriptionCode: 'delivered' })), edit({}, scan({ currentCountry: 7 })),
      edit({}, (details) => [...details, 'scan' as unknown as Scan]), { ...edit({}, unnamed), pieces: [] },
      edit({}, (details) => Array.from({ length: 301 }, () => details[0]!))]) {
      let kind: unknown = 'none';
      try { parseEmiratesCourier(reply, NUMBER); } catch (error) { kind = (error as { kind?: unknown }).kind; }
      expect(kind, JSON.stringify(reply)?.slice(0, 80)).toBe('schema');
    }
  });
});

describe('Emirates Courier Express statuses', () => {
  it('maps each code the tracker and its page give, and leaves its notices without a stage', () => {
    for (const entry of statuses.entries) {
      const wording = entry.wording.toLowerCase();
      expect(statusMap.stage(entry.code, wording), entry.code).toBe('stage' in entry ? entry.stage : undefined);
      expect(statusGapNote(statusMap, entry.code, wording), entry.code).toBe('stage' in entry ? undefined : entry.note);
    }
    expect(statusMap.stage('SHXZZZZ', 'anything')).toBe('exception');
    expect(statusMap.stage('PUXZZZZ', 'anything')).toBe('registered');
    expect(statusMap.stage('ZZZ', 'anything')).toBeUndefined();
    expect(statusMap.stage(null, 'shipment delivered')).toBeUndefined();
  });
});

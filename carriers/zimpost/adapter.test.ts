import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ZIMPOST_API, ZimpostTracker } from './adapter.js';
import { normalizeZimpostNumber, parseZimpost, parseZimpostReply } from './parser.js';
import { statusMap, zimpostMappedStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const NUMBER = 'CY584755815DE';
type Row = Record<string, unknown>;
interface Found { success: boolean; data: { trackingNumber: string; raw: { fid: string; data: { MAILITM_FID: string; events: Row[] } } } }
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const found = (): Found => JSON.parse(text('found')) as Found;
const edited = (change: (reply: Found, rows: Row[]) => void): Found => {
  const reply = found();
  change(reply, reply.data.raw.data.events);
  return reply;
};
const reply = (body: string, status = 200, type = 'application/json') => new Response(body, { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHECK = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';

describe('Zimpost tracking adapter', () => {
  it('takes S10 codes as they are printed and refuses a check digit that fails', () => {
    expect(normalizeZimpostNumber(' cy 584 755 815 de ')).toBe(NUMBER);
    expect(normalizeZimpostNumber('CY-584755815-DE')).toBe(NUMBER);
    // The tracking box's placeholder.
    expect(() => normalizeZimpostNumber('ZP123456789ZW')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    // The tracker's other example, eight characters, is no item code.
    expect(() => normalizeZimpostNumber('ZPPTDZ4Y')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('asks the overlay’s lookup for the whole code once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('found')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new ZimpostTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' cy 584 755 815 de ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${ZIMPOST_API}?number=${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'zimpost', step: 'direct', outcome: 'ok' }));
  });

  it('reads the IPS record of a parcel from abroad, newest first, each instant with the offset IPS states', () => {
    const result = parseZimpost(found().data, NUMBER);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Receive item at delivery office (Inb)', expected_delivery: null, weight_kg: 4.95, destination_country: 'ZW' });
    expect(result.events!.map(event => [event.time, event.location, event.description, event.provider_code, event.stage])).toEqual([
      // IPS states −7 hours for this scan; the GMT clock is its instant all the same.
      ['2024-05-31T00:38:17.743-07:00', 'BELMONT', 'Receive item at delivery office (Inb)', '32', 'in_transit'],
      ['2024-05-02T08:33:46.467+02:00', 'BELMONT', 'Receive item at delivery office (Inb)', '32', 'in_transit'],
      ['2024-04-25T11:30:10.100+02:00', 'BULAWAYO', 'Send item to domestic location (Inb)', '35', 'in_transit'],
      ['2024-04-25T11:02:21.413+02:00', 'BULAWAYO', 'Return item from customs (Inb)', '38', 'in_transit'],
      ['2024-04-25T11:00:14.700+02:00', 'BULAWAYO', 'Send item to customs (Inb)', '31', 'customs'],
      ['2024-04-25T10:57:50.677+02:00', 'BULAWAYO', 'Receive item at location (Inb)', '33', 'in_transit'],
      ['2024-04-24T09:37:09.263+02:00', 'HARARE CENTRAL SORTING OFFICE', 'Send item to domestic location (Inb)', '35', 'in_transit'],
      ['2024-04-24T09:31:45.880+02:00', 'HARARE CENTRAL SORTING OFFICE', 'Receive item at office of exchange (Inb)', '30', 'in_transit'],
    ]);
    expect(new Date(result.last_update!).toISOString()).toBe('2024-05-31T07:38:17.743Z');
    expect(result.events!.some(event => 'local_time' in event)).toBe(false);
  });

  it('keeps the instant in UTC when IPS states an offset no clock has', () => {
    const reply = edited((_, rows) => { rows[7]!.EVENT_LOCAL_OFFSET = 99; rows[6]!.EVENT_LOCAL_OFFSET = null; });
    const [latest, previous] = parseZimpost(reply.data, NUMBER).events!;
    expect(latest!.time).toBe('2024-05-31T07:38:17.743Z');
    expect(previous!.time).toBe('2024-05-02T06:33:46.467Z');
  });

  it('reads the delivery by its IPS event number', () => {
    const reply = edited((_, rows) => rows.push({ EVENT_INDEX: 9, EVENT_TYPE_CODE: 37, EVENT_TYPE: 'Deliver item (Inb)', INB_OTB_IND: 'I',
      EVENT_GMT_DATETIME: '2024-06-03T08:00:00.000', EVENT_LOCAL_OFFSET: 2, EVENT_OFFICE: 'BELMONT' }));
    expect(parseZimpost(reply.data, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered',
      last_status_text: 'Deliver item (Inb)', last_update: '2024-06-03T10:00:00+02:00' });
  });

  it('stages an event number the map does not know by IPS’s English name, or leaves it unstaged', () => {
    const reply = edited((_, rows) => {
      rows.push({ EVENT_INDEX: 9, EVENT_TYPE_CODE: 9001, EVENT_TYPE: 'Unrecognised event', EVENT_GMT_DATETIME: '2024-06-03T08:00:00', EVENT_LOCAL_OFFSET: 2 });
    });
    const result = parseZimpost(reply.data, NUMBER);
    expect(result.events![0]).toMatchObject({ provider_code: '9001', description: 'Unrecognised event', time: '2024-06-03T10:00:00+02:00' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result.events![0]).not.toHaveProperty('location');
    // The newest staged scan sets the stage; the newest scan the wording.
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Unrecognised event' });
  });

  it('requires the whole requested code in the IPS record and the tracker’s summary', () => {
    expect(() => parseZimpost(found().data, 'CY584755829DE')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const relabelled = edited(reply => { reply.data.trackingNumber = 'CY584755829DE'; });
    expect(() => parseZimpost(relabelled.data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const unnamed = edited(reply => { delete (reply.data.raw.data as Partial<Found['data']['raw']['data']>).MAILITM_FID; });
    expect(() => parseZimpost(unnamed.data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a record without events as no history, and a source other than IPS as a changed reply', () => {
    expect(() => parseZimpost(edited((_, rows) => rows.splice(0)).data, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseZimpost({ ...found().data, type: 'courier' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const undated = edited((_, rows) => { rows[0]!.EVENT_GMT_DATETIME = '2024-02-30T07:31:45'; });
    expect(() => parseZimpost(undated.data, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reports only the tracker’s own 404 reply as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found'), 404));
    await expect(carrier(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A page in place of the route, or another error, is not a missing item.
    expect(() => parseZimpostReply(404, '<!DOCTYPE html><html><body>404: This page could not be found.</body></html>', NUMBER))
      .toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseZimpostReply(404, JSON.stringify({ success: false, error: 'Upstream unavailable' }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseZimpostReply(200, JSON.stringify({ success: false, error: 'Tracking number not found' }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a block page, a rate limit, an outage and a redirect apart from a missing item', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK, 200, 'text/html'))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHECK, 403, 'text/html'))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('{}', 429))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('{"success":false}', 500))).track({ number: NUMBER }))
      .rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    const moved = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://www.zimpost.co.zw/' } }));
    await expect(carrier(moved).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'transport' });
    expect(() => parseZimpostReply(200, '{"success":true', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('sends a lookup that fails to reach the tracker once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('found')));
    await expect(carrier(fetcher).track({ number: NUMBER })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recognizes a code the tracker holds, and not one it does not hold or cannot take', async () => {
    const known = await carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('found')))).recognize!(NUMBER);
    expect(known).toEqual({ known: true, lastActivityAt: '2024-05-31T07:38:17.743Z' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(text('not-found'), 404))).recognize!(NUMBER))
      .resolves.toEqual({ known: false });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('ZPPTDZ4Y')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
  });

  it('maps every event number it records in statuses.json, and declares the same stages', () => {
    for (const entry of statuses.entries) {
      expect(zimpostMappedStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase()), entry.code).toBe(entry.stage);
    }
    expect(statusMap.stage('9001', 'unrecognised event')).toBeUndefined();
  });
});

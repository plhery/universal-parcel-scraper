import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MUSER_API, MUSER_CALLBACK, MUSER_PAGE, muserLookupUrl, MuserTracker } from './adapter.js';
import { normalizeMuserNumber, parseMuser } from './parser.js';
import { muserStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Made-up numbers: the fixture's parcel, and one the tracker does not know.
const PARCEL = 'MS73914286051937YD';
const UNKNOWN = 'MS48261937502816YD';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };
type Reply = Row & { data: Item[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name).replace(/^muserTrack\((.*)\)$/s, '$1')) as Reply;
const changed = (change: (item: Item, reply: Reply) => void) => {
  const reply = fixture('out-for-delivery');
  change(reply.data[0]!, reply);
  return reply;
};
const jsonp = (body: unknown) => `${MUSER_CALLBACK}(${JSON.stringify(body)})`;
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (date: string, description: string, location = '') => ({ trk_id: '1', tbs_id: '1', childpiece_id: null,
  track_occur_date: date, track_location: location, track_description: description, track_description_en: description,
  track_code: '', track_status: '', track_status_cnname: '', track_status_enname: '', gmt_offset: '+08:00' });

describe('Muser HTTP adapter', () => {
  it('asks the platform’s lookup for the whole number in capitals, with the platform’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('out-for-delivery')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new MuserTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ms 7391 4286 0519 37 yd ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'out_for_delivery' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(MUSER_API);
    // The key is the Base64 of the query's MD5 in hexadecimal.
    expect([...asked.searchParams]).toEqual([['callbackparam', MUSER_CALLBACK], ['method', 'track'],
      ['key', 'YTlmNTZkMjlhOWQyNTFlYjM1ZDRmMzMyNDVmNGQwMzU='], ['param', `{"sp":"","nums":["${PARCEL}"]}`]]); // gitleaks:allow
    expect(String(url)).toBe(muserLookupUrl(PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: MUSER_PAGE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'muser', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps every scan’s wall clock in the tracker’s order, the delivering network’s town in its state as the place, and none of the merchant’s details', () => {
    const result = parseMuser(fixture('out-for-delivery'), PARCEL);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', current_stage_source: 'carrier_map',
      last_status_text: 'Out for Delivery', last_update: null, last_update_local: '2026-07-24T09:46:00', expected_delivery: null,
      destination_country: 'US' });
    expect(result.events!.every((event) => event.local_time && !('time' in event) && !('provider_code' in event))).toBe(true);
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-07-24T09:46:00', 'COLUMBUS, OH', 'Out for Delivery', 'out_for_delivery'],
      ['2026-07-22T03:17:00', 'COLUMBUS, OH', 'Arrival Mail Processing Center', 'in_transit'],
      ['2026-07-20T15:31:42', undefined, 'Customs clearance completed', 'in_transit'],
      ['2026-07-19T15:30:58', undefined, 'The import customs keep it for inspection', 'customs'],
      ['2026-07-18T15:32:16', undefined, 'Customs clearanceisin progress', 'customs'],
      ['2026-07-17T15:31:05', undefined, 'Arrive at Airport', 'in_transit'],
      ['2026-07-15T15:30:47', undefined, 'Departure [HK International Airport]', 'in_transit'],
      ['2026-07-14T15:31:29', 'HONG KONG', 'Airline received', 'in_transit'],
      ['2026-07-13T15:32:03', 'HONG KONG', 'Handed over to the carrier for transportation', 'in_transit'],
      ['2026-07-12T15:30:36', 'HONG KONG', 'The shipment leaves the processing center', 'in_transit'],
      ['2026-07-10T10:24:51', 'HONG KONG', 'Express delivery arrives at the processing center', 'in_transit'],
      ['2026-07-09T16:08:17', 'HONG KONG', 'Shipment departed from facility', 'in_transit'],
      ['2026-07-09T10:43:09', 'HONG KONG', 'Package received and scanned at warehouse', 'accepted'],
    ]);
    const json = JSON.stringify(result);
    for (const excluded of ['43215', 'SAMPLE-ORDER', '美国', '快件', 'Normal transfer']) expect(json).not.toContain(excluded);
  });

  it('dates the scans by their places when the tracker is asked through a tracker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(MUSER_API)
      ? reply(text('out-for-delivery')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARCEL, carrier: 'muser' }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'muser', source: 'muser', result: { current_stage: 'out_for_delivery' } });
    expect(answer.result.events[0]).toMatchObject({ time: '2026-07-24T09:46:00-04:00', local_time: '2026-07-24T09:46:00',
      time_zone: 'America/New_York', time_zone_basis: 'place' });
    expect(answer.result.events.at(-1)).toMatchObject({ time: '2026-07-09T10:43:09+08:00', time_zone: 'Asia/Hong_Kong', time_zone_basis: 'place' });
  });

  it('takes the place out of a delivering network’s wording only past a run of spaces, with the state only for a United States ZIP Code', () => {
    const placed = (wording: string, country = 'US', location = '') => parseMuser(changed((item) => {
      item.destination_country = country;
      item.details = [scan('2026-07-08 08:00:00', wording, location)];
    }), PARCEL).events![0];
    expect(placed('Out for Delivery     SAMPLE TOWN 30301-1234')).toMatchObject({ location: 'SAMPLE TOWN, GA', description: 'Out for Delivery' });
    expect(placed('Out for Delivery   SAMPLE TOWN')).toMatchObject({ location: 'SAMPLE TOWN', description: 'Out for Delivery' });
    expect(placed('Out for Delivery     SAMPLE TOWN 30301', 'CA')).toMatchObject({ location: 'SAMPLE TOWN', description: 'Out for Delivery' });
    expect(placed('Out for Delivery  SAMPLE TOWN')).toMatchObject({ description: 'Out for Delivery SAMPLE TOWN' });
    expect(placed('Out for Delivery  SAMPLE TOWN')).not.toHaveProperty('location');
    // Two spaces part the wording from a town that ends in a ZIP Code.
    expect(placed('Delivered  SAMPLE TOWN 30301')).toMatchObject({ location: 'SAMPLE TOWN, GA', description: 'Delivered',
      stage: 'delivered', stage_source: 'carrier_map' });
    // A scan with a place of its own keeps its wording whole.
    expect(placed('Arrive at Airport     SAMPLE NOTE', 'US', 'HONG KONG')).toMatchObject({ location: 'HONG KONG', description: 'Arrive at Airport SAMPLE NOTE' });
  });

  it('stages an unmapped wording by the shared rules, and leaves a parcel with no staged scan unknown', () => {
    const worded = parseMuser(changed((item) => {
      item.details = [scan('2026-07-08 08:00:00', 'Delivered to front porch, signed by SAMPLE RECIPIENT'), scan('2026-07-07 07:00:00', 'Sample Status Note')];
    }), PARCEL);
    expect(worded.events!.map((event) => [event.local_time, event.description, event.stage, event.stage_source])).toEqual([
      ['2026-07-08T08:00:00', 'Delivered to front porch', 'delivered', 'wording:language'], ['2026-07-07T07:00:00', 'Sample Status Note', undefined, undefined]]);
    const unstaged = parseMuser(changed((item) => { item.details = [scan('2026-07-07 07:00:00', 'Sample Status Note')]; }), PARCEL);
    expect(unstaged).toMatchObject({ status: 'unknown', last_update: null, last_update_local: '2026-07-07T07:00:00' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('reads only the tracker’s unknown-number answer as not found, a parcel without scans as no history, and rejects a changed reply', () => {
    expect(() => parseMuser(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMuser({ success: 0, cnmessage: '参数错误', enmessage: 'Parameter error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMuser({ success: 0, cnmessage: null, enmessage: 'Sample failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseMuser(changed((item) => { item.details = []; }), PARCEL)).toThrow(NoHistoryError);
    for (const change of [
      (item: Item) => { item.server_hawbcode = UNKNOWN; },
      (item: Item, whole: Reply) => { whole.data.push({ ...item }); },
      (item: Item) => { (item as Row).details = null; },
      (item: Item) => { item.details[0]!.track_occur_date = '2026-02-30 08:00:00'; },
      (item: Item) => { item.details[0]!.track_description_en = 12; },
      (item: Item) => { item.details[0]!.track_location = 12; },
      (item: Item) => { item.destination_country = 12; },
    ]) expect(() => parseMuser(changed(change), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the reply in the callback it named or bare, and keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(fixture('out-for-delivery'))))).track({ number: PARCEL }))
      .resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.muserxm.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=00"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(`otherCallback(${JSON.stringify(fixture('not-found'))})`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(jsonp({ success: 0, enmessage: 'Parameter error' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses numbers outside Muser’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['MS7391428605193YD', 'MS739142860519370YD', 'MS73914286051937YQ', 'MX73914286051937YD', `MS${'7'.repeat(70)}YD`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeMuserNumber('ms-7391-4286-0519-37-yd')).toBe(PARCEL);
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('out-for-delivery')));
    await expect(carrier(flaky).track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'out_for_delivery' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
  });
});

describe('Muser numbers', () => {
  it('suggests MS, fourteen digits and YD, and recognition asks the tracker, which files a parcel it knows', async () => {
    expect(detectCarrierMatch(PARCEL)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['muser'] });
    for (const number of ['MS7391428605193YD', 'MS739142860519370YD', 'XMS73914286051937YD', 'MS73914286051937YDA']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('muser');
    }
    for (const countryHint of [undefined, 'US', 'GB']) expect(recognitionAskedCarriers(PARCEL, { countryHint })).toEqual(['muser']);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(MUSER_API)
      ? reply(text('out-for-delivery')) : new Response('', { status: 503 })));
    await expect(carrier(fetcher).recognize!(PARCEL)).resolves.toMatchObject({ known: true });
  });
});

describe('Muser status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'muser', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(muserStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(muserStage('Departure [SAMPLE Airport]')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(statusMap.stage(null, 'Sample Status Note')).toBeUndefined();
    expect(muserStage('Sample Status Note')).toBeNull();
  });
});

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
import { adapter, YWBZ_API, YWBZ_CALLBACK, YWBZ_PAGE, ywbzLookupUrl, YwbzTracker } from './adapter.js';
import { normalizeYwbzNumber, parseYwbz } from './parser.js';
import { statusMap, ywbzStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public examples the fixtures answer, and a number the tracker does not know.
const PARCEL = 'YWBZ2026900577';
const DELIVERED = 'YWBZ2025775701';
const UNKNOWN = 'YWBZ1000000001';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };
type Reply = Row & { data: Item[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name).replace(/^ywbzTrack\((.*)\)$/s, '$1')) as Reply;
const changed = (change: (item: Item, reply: Reply) => void, name = 'handed-over') => {
  const reply = fixture(name);
  change(reply.data[0]!, reply);
  return reply;
};
const jsonp = (body: unknown) => `${YWBZ_CALLBACK}(${JSON.stringify(body)})`;
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const scan = (date: string, offset: string, description: string, location = '') => ({ trk_id: '1', tbs_id: '1', childpiece_id: null,
  track_occur_date: date, track_location: location, track_description: description, track_description_en: description,
  track_code: null, track_status: '', track_status_cnname: '', track_status_enname: '', gmt_offset: offset });

describe('YWBZ Express HTTP adapter', () => {
  it('asks the platform’s lookup for the whole number in capitals, with the platform’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('handed-over')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new YwbzTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ywbz 2026 9005 77 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(YWBZ_API);
    // The key is the Base64 of the query's MD5 in hexadecimal.
    expect([...asked.searchParams]).toEqual([['callbackparam', YWBZ_CALLBACK], ['method', 'track'],
      ['key', 'YjZmZWZhM2I0YTkyNWQ4ZTlmMjdiODg3NDY3MjFlNDc='], ['param', `{"sp":"","nums":["${PARCEL}"]}`]]); // gitleaks:allow
    expect(String(url)).toBe(ywbzLookupUrl(PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: YWBZ_PAGE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'ywbz', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('dates the scans by the offsets their places state, and names the network the warehouse handed the parcel to', () => {
    const result = parseYwbz(fixture('handed-over'), PARCEL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'The flight has landed',
      last_update: '2026-11-17T22:22:00-08:00', expected_delivery: null, destination_country: 'US',
      delivery_carrier: 'swiftx', delivery_tracking_number: 'SWX193480000252562271' });
    expect(result).not.toHaveProperty('last_update_local');
    expect(result.events!.every((event) => event.time && !('local_time' in event) && !('provider_code' in event))).toBe(true);
    // Every scan has an instant, so the label SwiftX created in the United States sits by its instant, not its wall clock.
    expect(result.events!.slice(5, 9).map((event) => [event.time, event.location, event.description?.slice(0, 41), event.stage])).toEqual([
      ['2026-11-16T13:38:06+08:00', undefined, 'Exports Center Sorting and Packing', 'in_transit'],
      ['2026-11-15T22:28:10-07:00', 'US,SYSTEM', 'Shipping Label Created', 'registered'],
      ['2026-11-16T13:28:00+08:00', undefined, 'The warehouse changed the last-mile vendo', 'in_transit'],
      ['2026-11-16T13:28:00+08:00', undefined, 'Arrived at weighing district of warehouse', 'in_transit'],
    ]);
    // The pickup is read once, and mapped.
    expect(result.events!.filter((event) => event.description === 'First Mile - Pickup'))
      .toEqual([expect.objectContaining({ stage: 'in_transit', stage_source: 'carrier_map' })]);
    expect(result.events!.at(-1)).toMatchObject({ time: '2026-11-07T20:01:40+08:00', description: 'Shipment information received', stage: 'registered' });
  });

  it('keeps the wall clocks of scans without an offset in the tracker’s order, the delivering network’s wording without its place, and none of the merchant’s details', () => {
    const result = parseYwbz(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'delivered', last_update: null,
      last_update_local: '2026-04-11T17:27:00', destination_country: 'US' });
    expect(result).not.toHaveProperty('delivery_tracking_number');
    expect(result).not.toHaveProperty('signed_by');
    expect(result.events!.slice(0, 3).map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2026-04-11T17:27:00', 'DESOTO, TX', 'delivered', 'delivered'],
      ['2026-04-11T16:03:00', 'DESOTO, TX', 'Out for Delivery', 'out_for_delivery'],
      ['2026-04-11T06:19:00', 'DESOTO, TX', 'Arrived at USPS Facility', 'in_transit'],
    ]);
    expect(result.events!.find((event) => event.description === 'Accepted at USPS Regional Facility'))
      .toMatchObject({ location: 'METRO NY DISTRIBUTION CENTER', stage: 'in_transit', stage_source: 'carrier_map' });
    expect(result.events!.slice(-4).map((event) => [event.time ?? event.local_time, event.location])).toEqual([
      ['2026-04-01T14:41:34+08:00', 'YIWU'], ['2026-04-01T14:22:29', undefined], ['2026-04-01T14:08:09+08:00', 'YIWU'],
      ['2026-03-30T16:44:14+08:00', undefined]]);
    const json = JSON.stringify(result);
    for (const excluded of ['YSI21', '75115', '75211', '美国', 'Case Close']) expect(json).not.toContain(excluded);
  });

  it('hands on only a number the record or a hand-over scan gives, and names only a network the line was seen to use', () => {
    const handedTo = (number: string) => parseYwbz(changed((item) => {
      for (const row of item.details.filter((detail) => String(detail.track_description_en).includes('new tracking number'))) {
        row.track_description_en = `The warehouse changed the last-mile vendor due to the weight difference, the new tracking number is ${number}`;
      }
    }), PARCEL);
    expect(handedTo('SAMPLE0001')).toMatchObject({ delivery_tracking_number: 'SAMPLE0001' });
    expect(handedTo('SAMPLE0001')).not.toHaveProperty('delivery_carrier');
    // The tracker's own number is not a hand-off.
    expect(handedTo(PARCEL)).not.toHaveProperty('delivery_tracking_number');
    const channel = parseYwbz(changed((item) => { item.channel_hawbcode = 'SAMPLE0002'; }), PARCEL);
    expect(channel).toMatchObject({ delivery_tracking_number: 'SAMPLE0002' });
    expect(channel).not.toHaveProperty('delivery_carrier');
  });

  it.each([
    ['Arrived at export center', 'in_transit'],
    ['Arrived at weighing district of warehouse', 'in_transit'],
    ['Customs clearance completed', 'in_transit'],
    ['Customs released from origin port', 'in_transit'],
    ['Departed from export center', 'in_transit'],
    ['Exports center sorting and packing', 'in_transit'],
    ['In processing at transit facility.', 'in_transit'],
    ['In transit to next facility.', 'in_transit'],
    ['Item arrived at airport', 'in_transit'],
    ['Mainland China CN Departed from Sort Facility', 'in_transit'],
    ['Departed from Sort Facility', 'in_transit'],
    ['Mainland China, CN, Arrived at Origin Facility', 'in_transit'],
    ['Arrived at Origin Facility', 'in_transit'],
    ['Parcel departed from facility.', 'in_transit'],
    ['Parcel has been delivered.(Other secured locations)', 'delivered'],
    ['Parcel is out for delivery.', 'out_for_delivery'],
    ['Received by local delivery company', 'in_transit'],
    ['Parcel received by in LAX01.', 'in_transit'],
    ['Shipment information received', 'registered'],
    ['The flight has departed', 'in_transit'],
    ['The flight has landed', 'in_transit'],
    ['The warehouse changed the last-mile vendor due to the weight difference, the new tracking number is SAMPLE', 'in_transit'],
  ] as const)('reads %s as %s', (wording, stage) => {
    const payload = changed((item) => {
      item.details = [scan('2026-07-08 08:00:00', '+08:00', wording)];
    });
    expect(parseYwbz(payload, PARCEL).events![0]).toMatchObject({ stage, stage_source: 'carrier_map' });
  });

  it('stages an unmapped wording by the shared rules, and leaves a parcel with no staged scan unknown', () => {
    const worded = parseYwbz(changed((item) => {
      item.details = [scan('2026-07-08 08:00:00', '-04:00', 'Delivered, signed by SAMPLE RECIPIENT', 'SAMPLE TOWN'),
        scan('2026-07-07 07:00:00', '', 'Sample Status Note')];
    }), PARCEL);
    expect(worded.events!.map((event) => [event.time ?? event.local_time, event.description, event.stage, event.stage_source])).toEqual([
      ['2026-07-08T08:00:00-04:00', 'Delivered', 'delivered', 'wording:language'], ['2026-07-07T07:00:00', 'Sample Status Note', undefined, undefined]]);
    const unstaged = parseYwbz(changed((item) => { item.details = [scan('2026-07-07 07:00:00', '+08:00', 'Sample Status Note')]; }), PARCEL);
    expect(unstaged).toMatchObject({ status: 'unknown', last_update: '2026-07-07T07:00:00+08:00' });
    expect(unstaged).not.toHaveProperty('current_stage');
  });

  it('reads only the tracker’s unknown-number answer as not found, a parcel without scans as no history, and rejects a changed reply', () => {
    expect(() => parseYwbz(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseYwbz({ success: 0, cnmessage: '参数错误', enmessage: 'Parameter error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseYwbz({ success: 0, cnmessage: null, enmessage: 'Sample failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseYwbz(changed((item) => { item.details = []; }), PARCEL)).toThrow(NoHistoryError);
    for (const change of [
      (item: Item) => { item.server_hawbcode = UNKNOWN; },
      (item: Item, whole: Reply) => { whole.data.push({ ...item }); },
      (item: Item) => { (item as Row).details = null; },
      (item: Item) => { item.details[0]!.track_occur_date = '2026-02-30 08:00:00'; },
      (item: Item) => { item.details[0]!.track_description_en = 12; },
      (item: Item) => { item.channel_hawbcode = 12; },
    ]) expect(() => parseYwbz(changed(change), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the reply in the callback it named or bare, and keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(fixture('delivered'))))).track({ number: DELIVERED }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'http://www.ywbzexpress.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=00"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(`otherCallback(${JSON.stringify(fixture('not-found'))})`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(jsonp({ success: 0, enmessage: 'Parameter error' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses numbers outside YWBZ’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['YWBZ202690057', 'YWBZ20269005770', 'YWB2026900577', 'YWBX2026900577', `YWBZ${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeYwbzNumber('ywbz-2026-9005-77')).toBe(PARCEL);
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('handed-over')));
    await expect(carrier(flaky).track({ number: PARCEL })).resolves.toMatchObject({ current_stage: 'in_transit' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const started = performance.now();
    const slow = delayedFetcher([{ afterMs: Infinity }, { afterMs: Infinity }]);
    const spent = expect(carrier(slow.fetcher).track({ number: PARCEL }, { budgetMs: 120 })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(120);
    await spent;
    expect(slow.ended.map((at) => at - started)).toEqual([60, 120]);
  });
});

describe('YWBZ Express numbers', () => {
  it('claims YWBZ and ten digits whole, and nothing shorter or longer', async () => {
    for (const number of [PARCEL, DELIVERED]) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'ywbz', confidence: 'high', candidates: ['ywbz'] });
    }
    for (const number of ['YWBZ202690057', 'YWBZ20269005770', 'XYWBZ2026900577', 'YWBZ2026900577A']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('ywbz');
    }
    expect(recognitionAskedCarriers(PARCEL, {})).not.toContain('swiftx');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(YWBZ_API)
      ? reply(text('delivered')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'ywbz', source: 'ywbz', result: { current_stage: 'delivered' } });
  });
});

describe('YWBZ Express status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'ywbz', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(ywbzStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.stage(null, 'Sample Status Note')).toBeUndefined();
    expect(ywbzStage('Sample Status Note')).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NoHistoryError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { delayedFetcher } from '../../core/testing/hang.js';
import { fakeBudgetClock } from '../../testing/budgetClock.js';
import { createTracker } from '../../facade/index.js';
import { adapter, PRD_API, PRD_CALLBACK, PRD_PAGE, prdLookupUrl, PrdTracker } from './adapter.js';
import { normalizePrdNumber, parsePrd } from './parser.js';
import { prdStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The synthetic parcel the fixture answers, and a number the tracker does not know.
const PARCEL = 'PRD0000000271828';
const UNKNOWN = 'PRD0000000000000';

type Row = Record<string, unknown>;
type Item = Row & { details: Row[] };
type Reply = Row & { data: Item[] };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name).replace(/^prdTrack\((.*)\)$/s, '$1')) as Reply;
const changed = (change: (item: Item, reply: Reply) => void) => {
  const reply = fixture('in-transit');
  change(reply.data[0]!, reply);
  return reply;
};
const jsonp = (body: unknown) => `${PRD_CALLBACK}(${JSON.stringify(body)})`;
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Prime Express HTTP adapter', () => {
  it('asks the platform’s lookup for the whole number in capitals, with the platform’s key, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(text('in-transit')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PrdTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' prd 0000000 271828 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [[url, init]] = fetcher.mock.calls as [[string, RequestInit]];
    const asked = new URL(String(url));
    expect(`${asked.origin}${asked.pathname}`).toBe(PRD_API);
    expect([...asked.searchParams].map(([name]) => name)).toEqual(['callbackparam', 'method', 'key', 'param']);
    expect(asked.searchParams.get('param')).toBe(`{"sp":"","nums":["${PARCEL}"]}`);
    expect(String(url)).toBe(prdLookupUrl(PARCEL));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Referer: PRD_PAGE, 'User-Agent': 'SyntheticHost/1.0',
    } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'prd', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the wall clocks in the tracker’s order, names J&T Express Germany by its number, and none of the merchant’s details', () => {
    const result = parsePrd(fixture('in-transit'), PARCEL);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Prepared for last mile handover', last_update: null, last_update_local: '2030-03-12T15:41:00',
      destination_country: 'DE', delivery_carrier: 'j-and-t-de', delivery_tracking_number: 'JTDE271828182845' });
    const events = result.events ?? [];
    expect(events).toHaveLength(16);
    expect(events[0]).toEqual({ local_time: '2030-03-12T15:41:00', location: 'AMS', description: 'Prepared for last mile handover',
      stage: 'in_transit', stage_source: 'carrier_map' });
    expect(events[2]).toMatchObject({ description: 'Inbound to customs temporary warehouse', stage: 'customs' });
    expect(events.at(-1)).toMatchObject({ local_time: '2030-03-04T16:44:59', stage: 'registered' });
    // J&T Express Germany's notice has no place.
    expect(events.at(-2)).toEqual({ local_time: '2030-03-05T17:01:16', stage: 'registered', stage_source: 'carrier_map',
      description: 'Die Auftragsdaten für diese Sendung wurden elektronisch an J&T Express übermittelt' });
    expect(JSON.stringify(result)).not.toMatch(/S000000000000000001|signatory|pod_url/);
  });

  it('names a delivering carrier only when its rules claim the number whole', () => {
    expect(parsePrd(changed((item) => { item.channel_hawbcode = 'XY12345678'; }), PARCEL))
      .toMatchObject({ delivery_tracking_number: 'XY12345678' });
    expect(parsePrd(changed((item) => { item.channel_hawbcode = 'XY12345678'; }), PARCEL)).not.toHaveProperty('delivery_carrier');
    for (const channel of ['', PARCEL, null]) {
      const result = parsePrd(changed((item) => { item.channel_hawbcode = channel; }), PARCEL);
      expect(result).not.toHaveProperty('delivery_tracking_number');
      expect(result).not.toHaveProperty('delivery_carrier');
    }
  });

  it('reads only the tracker’s unknown-number answer as not found, a parcel without scans as no history, and rejects a changed reply', () => {
    expect(() => parsePrd(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePrd({ success: 0, cnmessage: '参数错误', enmessage: 'Parameter error' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePrd({ success: 0, cnmessage: null, enmessage: 'Sample failure' }, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePrd(changed((item) => { item.details = []; }), PARCEL)).toThrow(NoHistoryError);
    for (const change of [
      (item: Item) => { item.server_hawbcode = UNKNOWN; },
      (item: Item, whole: Reply) => { whole.data.push({ ...item }); },
      (item: Item) => { (item as Row).details = null; },
      (item: Item) => { item.details[0]!.track_occur_date = '2030-02-30 08:00:00'; },
      (item: Item) => { item.details[0]!.track_description_en = 12; },
      (item: Item) => { item.channel_hawbcode = 12; },
    ]) expect(() => parsePrd(changed(change), PARCEL)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps an unknown number, a moved route, a browser check and a broken reply apart', async () => {
    const lookup = (body: string, init?: ResponseInit) => carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number: UNKNOWN });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(JSON.stringify(fixture('in-transit'))))).track({ number: PARCEL }))
      .resolves.toMatchObject({ current_stage: 'in_transit' });
    await expect(lookup(text('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(text('not-found'), { status: 404 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 302, headers: { Location: 'https://www.primexpslogistics.com/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('<html><script>document.cookie="acw_sc__v2=00"</script></html>')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(`otherCallback(${JSON.stringify(fixture('not-found'))})`)).rejects.toMatchObject({ kind: 'schema' });
    await expect(lookup(jsonp({ success: 0, enmessage: 'Parameter error' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [503, 'maintenance']] as const)('preserves HTTP %s as %s, without a retry', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
    await expect(carrier(fetcher).track({ number: PARCEL })).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('refuses numbers outside Prime Express’s layout, and pre-aborted or spent lookups, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['PRD000000027182', 'PRD00000002718280', 'PR0000000271828', 'PRX0000000271828', `PRD${'0'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: PARCEL }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(fetcher).track({ number: PARCEL }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizePrdNumber('prd-0000000-271828')).toBe(PARCEL);
  });

  it('sends a read that fails to connect or hangs once more inside the budget', async () => {
    fakeBudgetClock();
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('in-transit')));
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

describe('Prime Express numbers', () => {
  it('claims PRD and thirteen digits whole, and nothing shorter or longer', async () => {
    expect(detectCarrierMatch(PARCEL)).toMatchObject({ carrier: 'prd', confidence: 'high', candidates: ['prd'] });
    for (const number of ['PRD000000027182', 'PRD00000002718280', 'XPRD0000000271828', 'PRD0000000271828A']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('prd');
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => (String(url).startsWith(PRD_API)
      ? reply(text('in-transit')) : new Response('', { status: 503 })));
    const answer = await createTracker({ fetcher, providers: [], env: {} }).track({ number: PARCEL }, { budgetMs: 3000 });
    expect(answer).toMatchObject({ carrier: 'prd', source: 'prd', result: { current_stage: 'in_transit' } });
  });
});

describe('Prime Express status vocabulary', () => {
  it('maps every wording it recorded to the stage recorded for it, and the app reads the map', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'prd', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
      expect(prdStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.stage(null, 'Sample Status Note')).toBeUndefined();
    expect(prdStage('Sample Status Note')).toBeNull();
  });
});

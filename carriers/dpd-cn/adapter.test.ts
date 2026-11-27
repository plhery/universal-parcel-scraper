import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { languageStageStatus, STAGES, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { dateLocalClocks } from '../../places/clocks.js';
import {
  adapter, DPD_CN_API, dpdCnPlace, dpdCnRequestBody, DpdCnTracker, normalizeDpdCnNumber, parseDpdCn, parseDpdCnReply, withoutContacts,
} from './adapter.js';
import { statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// The synthetic shape check; the fixtures are synthetic, except the reply for the all-zero placeholder.
const NUMBER = numbers.records[0]!.number;
const PLACEHOLDER = '00000000000000';
const NOT_FOUND = readFileSync(new URL('./fixtures/not-found.json', import.meta.url), 'utf8');
const delivered = () => JSON.parse(readFileSync(new URL('./fixtures/synthetic-delivered.json', import.meta.url), 'utf8'));
type Result = ReturnType<typeof delivered>;
const changed = (edit: (row: Result, result: Result) => void): Result => {
  const result = delivered(); edit(result.ListHawbDetails[0], result); return result;
};
/** The envelope the service wraps its result in, as JSON text. */
const envelope = (result: unknown = delivered(), fields: Record<string, unknown> = {}) =>
  ({ result: typeof result === 'string' ? result : JSON.stringify(result), targetUrl: null, success: true, error: null, unAuthorizedRequest: false, __abp: true, ...fields });
const json = (data: unknown, status = 200) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const replying = (reply: () => Response) => vi.fn<typeof fetch>().mockImplementation(async () => reply());
const found = () => replying(() => json(envelope()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const parse = (result: unknown, number = NUMBER) => parseDpdCn(envelope(result), number);
const scan = (Desc: string, EventTime = '2026-11-13 10:00:00', fields: Record<string, unknown> = {}) =>
  ({ Desc, Url: null, EventTime, LocationName: 'Spain', IsDelivered: false, ...fields });

describe('DPD China tracking adapter', () => {
  it('posts the number as the tracker’s script does, with the supplied transport and budget', async () => {
    const fetcher = found();
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new DpdCnTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(19);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(DPD_CN_API);
    expect(DPD_CN_API).toBe('https://apitracking.hub-ez.com/api/services/app/tracking/GetTrackingNew');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({
      Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json;charset=utf-8',
      Origin: 'https://tracking.dpd.cn', Referer: 'https://tracking.dpd.cn/', 'User-Agent': 'SyntheticHost/1' }) });
    expect(init!.body).toBe(dpdCnRequestBody(NUMBER));
    // `para` is JSON text inside the JSON body, and `H` searches tracking numbers.
    expect(JSON.parse(JSON.parse(String(init!.body)).para)).toEqual({ trackingNumber: NUMBER, hawbType: 'H' });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'dpd-cn', step: 'direct', outcome: 'ok' }));
    expect(carrier(fetcher)).toMatchObject({ id: 'dpd-cn', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number the tracker does not take without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '8415999999999' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(carrier(fetcher).recognize!('8415999999999')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
    for (const number of ['', '8415999999999', '841599999999901', 'JJD84159999999990', '8415999999999A', `${NUMBER}?`, '8'.repeat(70)]) {
      expect(() => normalizeDpdCnNumber(number), number).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(normalizeDpdCnNumber(` ${NUMBER.slice(0, 4)} ${NUMBER.slice(4)} `)).toBe(NUMBER);
  });

  it('reads the NotFound row that repeats the number as not found, which recognition reads as unknown', async () => {
    const fetcher = replying(() => json(NOT_FOUND));
    await expect(carrier(fetcher).track({ number: PLACEHOLDER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(carrier(fetcher).recognize!(PLACEHOLDER)).resolves.toEqual({ known: false });
    const own = replying(() => json(NOT_FOUND.replaceAll(PLACEHOLDER, NUMBER)));
    await expect(carrier(own).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(own).recognize!(NUMBER)).resolves.toEqual({ known: false });
  });

  it('keeps a row for another number, a failed answer and a refused request apart from a missing parcel', async () => {
    const answer = async (body: unknown) => carrier(replying(() => json(body))).track({ number: NUMBER }).catch((error: unknown) => error);
    const recognized = async (body: unknown) => carrier(replying(() => json(body))).recognize!(NUMBER).catch((error: unknown) => error);
    expect(await answer(NOT_FOUND)).toMatchObject({ kind: 'indeterminate' });
    expect(await recognized(NOT_FOUND)).toMatchObject({ kind: 'indeterminate' });
    const failed = { result: null, targetUrl: null, success: false, error: { code: 0, message: 'Synthetic failure', details: null }, unAuthorizedRequest: false, __abp: true };
    expect(await answer(failed)).toMatchObject({ kind: 'indeterminate' });
    expect(await recognized(failed)).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(envelope(delivered(), { error: { message: 'Synthetic failure' } }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(envelope(delivered(), { success: false }))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer({ ...failed, error: null, unAuthorizedRequest: true })).toMatchObject({ kind: 'challenge' });
    const twice = changed((row, result) => { result.ListHawbDetails.push(row); });
    expect(await answer(envelope(twice))).toMatchObject({ kind: 'indeterminate' });
  });

  it('reads a changed reply as a schema failure, never as not found', async () => {
    const answer = async (body: unknown) => carrier(replying(() => json(body))).track({ number: NUMBER }).catch((error: unknown) => error);
    for (const body of [
      [], 'null', '{}', envelope(delivered(), { result: undefined }), envelope(delivered(), { result: null }), envelope('not json'), envelope('[]'),
      envelope({ ListHawbDetails: {} }), envelope({ ListHawbDetails: [] }), envelope({ ListHawbDetails: [1] }),
      envelope(changed((row) => { delete row.NotFound; })), envelope(changed((row) => { row.NotFound = 'false'; })),
      envelope(changed((row) => { row.NotFound = true; })), envelope(changed((row) => { row.ListTrackingDetails = {}; })),
      envelope(changed((row) => { row.ListTrackingDetails[0] = 'scan'; })),
      envelope(changed((row) => { row.ListTrackingDetails[0].EventTime = '12/11/2026 18:02'; })),
      envelope(changed((row) => { row.ListTrackingDetails[0].EventTime = '2026-02-30 18:02:41'; })),
      envelope(changed((row) => { Object.assign(row.ListTrackingDetails[0], { Desc: ' ', Url: null }); })),
    ]) expect(await answer(body), JSON.stringify(body).slice(0, 200)).toMatchObject({ kind: 'schema' });
  });

  it('reads a verification page as a challenge and another page as a changed service', async () => {
    const answer = async (body: string) => carrier(replying(() => new Response(body, { headers: { 'Content-Type': 'text/html' } })))
      .track({ number: NUMBER }).catch((error: unknown) => error);
    expect(await answer('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>')).toMatchObject({ kind: 'challenge' });
    expect(await answer('<!doctype html><html><head><title>DPD Tracking</title></head><body><div id="app"></div></body></html>'))
      .toMatchObject({ kind: 'schema' });
    expect(() => parseDpdCnReply('<html><title>Access Denied</title></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
  });

  it.each([[302, 'transport'], [404, 'transport'], [410, 'transport'], [403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'],
    [503, 'maintenance']] as const)('keeps HTTP %i apart from a missing parcel', async (status, kind) => {
    const fetcher = replying(() => (status === 302 ? new Response(null, { status, headers: { Location: 'https://tracking.dpd.cn/' } })
      : new Response('<html><body>Synthetic error</body></html>', { status, headers: { 'Content-Type': 'text/html', 'retry-after': '60' } })));
    const error = await carrier(fetcher).track({ number: NUMBER }, { budgetMs: 2000 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind });
    await expect(carrier(fetcher).recognize!(NUMBER, { budgetMs: 2000 })).rejects.toMatchObject({ kind });
  });

  it('sends the lookup once more when it fails to reach the service', async () => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('synthetic socket reset');
      return json(envelope());
    });
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new DpdCnTracker({ fetcher, recorder }).fetch(NUMBER, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    await expect(new DpdCnTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).rejects.toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new DpdCnTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection, dates the scans on their facilities’ clocks, and recognition confirms scans', async () => {
    const answer = await createTracker({ fetcher: found(), env: {}, providers: [] }).track({ carrier: 'dpd-cn', number: NUMBER });
    expect(answer).toMatchObject({ carrier: 'dpd-cn', source: 'dpd-cn', result: { current_stage: 'delivered', destination_country: 'ES' } });
    expect(answer.result.events.find((event) => event.stage === 'delivered')).toMatchObject({ time: '2026-11-12T13:47:55+01:00' });
    expect(answer.result.events.find((event) => event.stage === 'accepted')).toMatchObject({ time: '2026-11-04T21:15:27+08:00' });
    await expect(carrier(found()).recognize!(NUMBER)).resolves.toEqual({ known: true, lastActivityAt: null, lastActivityLocal: '2026-11-12T18:02:41', finished: true });
    // A row the service lists without a scan shows no DPD China parcel: Lenton Group's other trackers share the service.
    const listed = changed((row) => { row.ListTrackingDetails = []; });
    await expect(carrier(replying(() => json(envelope(listed)))).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('offers the depot prefix as a low suggestion that recognition asks', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['dpd-cn']) });
    expect(detectCarrierMatch(NUMBER).candidates[0]).toBe('dpd-cn');
    expect(recognitionCandidates(NUMBER).map((candidate) => candidate.carrier)).toContain('dpd-cn');
    // Another DPD depot's fourteen digits are not DPD China's.
    const elsewhere = `0150${NUMBER.slice(4)}`;
    expect(detectCarrierMatch(elsewhere).candidates).not.toContain('dpd-cn');
    expect(recognitionCandidates(elsewhere).map((candidate) => candidate.carrier)).not.toContain('dpd-cn');
  });
});

describe('DPD China replies', () => {
  it('reads the scans newest first on their facilities’ wall clocks, with the delivery scan as the stage', () => {
    const result = parse(delivered());
    expect(result).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The signature or the runsheet completed has been received. POD available', last_update: null,
      last_update_local: '2026-11-12T18:02:41', expected_delivery: null, destination_country: 'ES' });
    expect(result.events!.map((event) => [event.local_time, event.location, event.stage ?? null])).toEqual([
      ['2026-11-12T18:02:41', 'Spain', null],
      ['2026-11-12T13:48:10', 'Spain', null],
      ['2026-11-12T13:47:55', 'Spain', 'delivered'],
      ['2026-11-12T08:31:02', 'Spain', 'out_for_delivery'],
      ['2026-11-12T07:15:20', 'Spain', null],
      ['2026-11-12T06:40:13', 'Spain', 'in_transit'],
      ['2026-11-11T22:05:37', 'Spain', 'in_transit'],
      ['2026-11-11T19:22:08', 'Spain', 'in_transit'],
      ['2026-11-10T23:51:44', 'Germany', 'in_transit'],
      ['2026-11-10T21:16:30', 'Germany', 'in_transit'],
      ['2026-11-10T14:02:51', 'Germany', 'in_transit'],
      ['2026-11-10T09:37:19', 'Germany', 'in_transit'],
      ['2026-11-09T16:44:02', 'Belgium', 'in_transit'],
      ['2026-11-05T03:05:42', 'Shenzhen', 'in_transit'],
      ['2026-11-05T02:30:11', 'Shenzhen', 'in_transit'],
      ['2026-11-04T21:15:27', 'Shenzhen', 'accepted'],
      ['2026-11-04T19:20:00', 'Spain', null],
      ['2026-11-03T18:40:03', 'Shenzhen', 'registered'],
      ['2026-11-03T10:12:45', 'Shenzhen', 'registered'],
    ]);
    expect(result.events!.every((event) => !('time' in event) && (!event.stage || event.stage_source === 'carrier_map'))).toBe(true);
    // The proof of delivery is marked delivered by the tracker, yet it follows the delivery scan.
    expect(result.events!.filter((event) => event.stage === 'delivered')).toHaveLength(1);
    expect(result.events![14]).toMatchObject({ description: 'Add Hawb to Mawb 000-00000000', stage: 'in_transit' });
    expect(JSON.stringify(result)).not.toMatch(/CustomerRef|Pieces|Package/);
  });

  it('puts each scan on its facility’s clock', () => {
    const { events } = dateLocalClocks('dpd-cn', parse(delivered()));
    expect(events!.map((event) => event.time)).toEqual(expect.arrayContaining([
      '2026-11-12T13:47:55+01:00', '2026-11-10T09:37:19+01:00', '2026-11-09T16:44:02+01:00', '2026-11-04T21:15:27+08:00', '2026-11-03T10:12:45+08:00',
    ]));
    expect(events!.filter((event) => event.location !== 'Spain' || event.stage).every((event) => event.time_zone_basis === 'place')).toBe(true);
    // The recipient's early choice, filed under the destination, keeps its wall clock.
    expect(events![16]).toMatchObject({ local_time: '2026-11-04T19:20:00', location: 'Spain', description: 'Redirection Requested to safe place' });
  });

  it('keeps the stage of the scan before a notice, including a redirection made before the parcel left China', () => {
    const upTo = (first: number) => changed((row) => { row.ListTrackingDetails = row.ListTrackingDetails.slice(first); });
    expect(parse(upTo(4))).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Email notification has been sent successfully!' });
    expect(parse(upTo(16))).toMatchObject({ current_stage: 'registered', last_status_text: 'Redirection Requested to safe place' });
    expect(parse(upTo(1))).toMatchObject({ current_stage: 'delivered', last_status_text: 'Signature available' });
    expect(parse(upTo(16)).events![0]!.stage).toBeUndefined();
  });

  it('reads a scan the map lacks by the tracker’s delivered mark, then its wording, then the row’s status', () => {
    const only = (rows: unknown[], status = 'InTransit') => changed((row) => { row.ListTrackingDetails = rows; row.Status = status; });
    expect(parse(only([scan('Synthetic hand-over', undefined, { IsDelivered: true })]))).toMatchObject({ current_stage: 'delivered', current_stage_source: 'carrier_map' });
    const worded = parse(only([scan('Parcel delivered to the recipient')]));
    expect(worded.current_stage).toBe('delivered');
    expect(worded.current_stage_source).not.toBe('carrier_map');
    expect(parse(only([scan('Synthetic note')]))).toMatchObject({ current_stage: 'in_transit', current_stage_source: 'carrier_map' });
    expect(parse(only([scan('Synthetic note')], 'Exception'))).toMatchObject({ current_stage: 'exception' });
    expect(parse(only([scan('Synthetic note')], 'Synthetic'))).toMatchObject({ status: 'unknown' });
    expect(parse(only([scan('Synthetic note')], 'Synthetic')).current_stage).toBeUndefined();
    // The row's status is read only when no scan has a stage.
    expect(parse(only([scan('Synthetic note', '2026-11-14 10:00:00'), scan('Hub inbound')], 'Delivered'))).toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads the wording of a linked scan without its link, and leaves out contacts', () => {
    const linked = changed((row) => {
      row.ListTrackingDetails.unshift(scan('', '2026-11-13 09:00:00', { Url: '<a href="https://example.com/pod?id=1">Signature available</a>' }));
      row.ListTrackingDetails.unshift(scan('Notification has been sent to synthetic.person@example.com successfully!', '2026-11-13 10:00:00'));
    });
    const result = parse(linked);
    expect(result.events!.slice(0, 2).map((event) => event.description)).toEqual(['Notification has been sent to successfully!', 'Signature available']);
    expect(JSON.stringify(result)).not.toMatch(/example\.com|synthetic\.person/);
    expect(withoutContacts('Call +34 600 000 000 to arrange the delivery')).toBe('Call to arrange the delivery');
    expect(withoutContacts('Add Hawb to Mawb 999-12345675')).toBe('Add Hawb to Mawb 999-12345675');
    expect(withoutContacts('Hub sorted')).toBe('Hub sorted');
  });

  it('writes towns in plain case and reads the destination from the row', () => {
    expect(['ShenZhen', 'SHENZHEN', ' DongGuan ', 'Spain ', 'United Kingdom', 'HK', 'Hong Kong', null].map(dpdCnPlace))
      .toEqual(['Shenzhen', 'Shenzhen', 'Dongguan', 'Spain', 'United Kingdom', 'HK', 'Hong Kong', '']);
    expect(parse(changed((row) => { row.FromTo = ['China', 'Italy']; }))).toMatchObject({ destination_country: 'IT' });
    const named = parse(changed((row) => { row.FromTo = ['China', 'Synthetic Land']; }));
    expect(named).toMatchObject({ destination_country_name: 'Synthetic Land' });
    expect(named.destination_country).toBeUndefined();
    for (const FromTo of [[null, null], null, 'Spain']) {
      const result = parse(changed((row) => { row.FromTo = FromTo; }));
      expect(result.destination_country ?? result.destination_country_name, JSON.stringify(FromTo)).toBeUndefined();
    }
  });

  it('reads a listed row without a scan as no history', () => {
    expect(() => parse(changed((row) => { row.ListTrackingDetails = []; }))).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parse(changed((row) => { delete row.ListTrackingDetails; }))).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('stages every recorded wording and status as the status map answers', () => {
    for (const entry of statuses.entries) {
      const code = 'code' in entry ? entry.code ?? null : null;
      if (entry.stage !== null) expect(STAGES).toContain(entry.stage);
      expect(statusMap.stage(code, normalizeStatusWording(entry.wording)) ?? null, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'dpd-cn', providerCode: code, description: entry.wording }), entry.wording)
        .toEqual(entry.stage ? { kind: 'mapped', stage: entry.stage as Stage } : { kind: 'intentional_gap', note: entry.note });
    }
    expect(statusMapAnswer({ carrier: 'dpd-cn', providerCode: null, description: 'Add Hawb to Mawb 999-12345675' })).toEqual({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMap.stage(null, 'synthetic note')).toBeUndefined();
  });
});

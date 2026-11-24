import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, LionTracker } from './adapter.js';
import { lionUrl, normalizeLionNumber, parseLion, parseLionReply } from './parser.js';
import { lionGroup, lionRail, lionScan, statusMap } from './status.js';

describe('360Lion numbers', () => {
  it('suggests 360Lion for AR and ten digits and asks its tracker, but not for other countries\' letters', () => {
    for (const number of ['AR0000000001', 'ar 0000000001']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ confidence: 'low' });
      expect(detectCarrierMatch(number).candidates, number).toContain('360lion');
      for (const countryHint of [undefined, 'AR', 'CN']) expect(recognitionAskedCarriers(number, { countryHint }), `${number} ${countryHint}`).toContain('360lion');
    }
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).toContain('360lion');
    for (const other of ['AR000000001', 'AR00000000001', 'AB0000000001', 'MX0000000001', 'CO0000000001', 'XAR0000000001']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('360lion');
    }
  });

  it('suggests 360Lion for JTC and twelve digits and asks its tracker, and only for that whole shape', () => {
    for (const number of ['JTC999999999901', 'jtc 999999999901']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['360lion'] });
      for (const countryHint of [undefined, 'CO', 'CN']) expect(recognitionAskedCarriers(number, { countryHint }), `${number} ${countryHint}`).toContain('360lion');
    }
    for (const other of ['JTC99999999990', 'JTC9999999999012', 'JTE999999999901', 'JTCO999999999901', 'XJTC999999999901']) {
      expect(detectCarrierMatch(other).candidates ?? [], other).not.toContain('360lion');
    }
  });

  it('recognizes a number its tracker lists with scans and not one it files as not found', async () => {
    const lookups = [response(changed(parcel => { parcel.hawbCode = 'AR0000000001'; })), response(missing('AR0000000002'))];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => lookups.shift()!);
    const lion = adapter({ fetcher, env: {}, recorder: NOOP_RECORDER } as never);
    await expect(lion.recognize!('AR0000000001', { budgetMs: 5_000 })).resolves.toMatchObject({ known: true });
    await expect(lion.recognize!('AR0000000002', { budgetMs: 5_000 })).resolves.toEqual({ known: false });
    await expect(lion.recognize!('AR-1', { budgetMs: 5_000 })).resolves.toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

const NUMBER = 'WSHAR0000000001YQ';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
const changed = (edit: (parcel: ReturnType<typeof fixture>, data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data.data.trackList[0], data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage: string }[] };
// The service's answer for a number it does not know, as it came for another carrier's public number.
const missing = (number = NUMBER) => ({ msg: 'operation successful', code: 200, data: {
  groupList: [{ groupCode: 'ALL', quantity: '1' }, { groupCode: 'NOT_FOUNT', quantity: '1' }],
  trackList: [{ hawbCode: number, lastTrackStatus: '-1', lastTrackStatusCn: '未知', lastTrackStatusEn: '未知', departureCountry: '中国', departureCountryEn: 'China',
    groupCode: 'NOT_FOUNT', trackSub: { subRage: ['HUB', 'TRANSPORT', 'AIRPORT', 'CUSTOMS', 'DISPATCH', 'DELIVERED'], transmitType: 'air' } }] } });
const scan = (fields: Record<string, unknown>) => ({ occurDate: '2026-03-13 10:00:00', timeZone: '-3', location: 'AR', oriDescription: 'Synthetic wording', description: 'synthetic wording', trackCode: 'WSD999', ...fields });

describe('360Lion guest adapter', () => {
  it('asks for the whole number once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new LionTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://toms.360lion.com/prod-api/toms/crossSite/oms/hawbcode/v2?codes=${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.method).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: '360lion', step: 'direct', outcome: 'ok' }));
    expect(lionUrl('AR0000000001')).toBe('https://toms.360lion.com/prod-api/toms/crossSite/oms/hawbcode/v2?codes=AR0000000001');
  });

  it("reads the scans newest first on each place's stated offset, in the wording the page shows", () => {
    expect(parseLion(fixture().data, NUMBER)).toEqual({ status: languageStageStatus('in_transit'), current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Transit in Destination Country', provider_code: 'IN_TRANSIT', destination_country: 'AR', last_update: '2026-03-12T14:37:28-03:00', expected_delivery: null,
      events: [
        { time: '2026-03-12T14:37:28-03:00', description: 'Salida(El paquete ya está cargado al vehículo a la próxima estación.)', location: 'Argentina', provider_code: 'WSD050', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-12T11:30:24-03:00', description: 'Arribado DC(El paquete ha llegado a la estación.)', location: 'Argentina', provider_code: 'WSD051', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-12T11:30:23-03:00', description: 'Recibido(Ya recibió el paquete.)', location: 'Argentina', provider_code: 'WSD02', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-04T09:35:00-03:00', description: 'arrived at airport', location: 'EZE', provider_code: 'WSD00', stage: 'in_transit', stage_source: 'carrier_map' },
        { time: '2026-03-01T03:05:00+08:00', description: 'departed from airport', location: 'PVG', provider_code: 'WSO04', stage: 'in_transit', stage_source: 'carrier_map' },
      ] });
    // Without the last mile's wording a scan takes 360Lion's English.
    expect(parseLion(changed(p => { delete p.trackItemList[0].oriDescription; }).data, NUMBER).events![0]!.description).toBe('package on the way to delivery office');
    // Scans of one instant keep the reply's order, newest first.
    const tied = parseLion(changed(p => { p.trackItemList[1].occurDate = p.trackItemList[2].occurDate; }).data, NUMBER);
    expect(tied.events!.slice(1, 3).map(event => event.provider_code)).toEqual(['WSD051', 'WSD02']);
  });

  it('reads offsets of half and quarter hours, and rejects a scan whose clock or offset it cannot read', () => {
    const at = (timeZone: unknown, occurDate: unknown = '2026-03-13 10:00:00') => parseLion(changed(p => { p.trackItemList.unshift(scan({ timeZone, occurDate })); }).data, NUMBER).events![0]!.time;
    expect(at('+5.5')).toBe('2026-03-13T10:00:00+05:30');
    expect(at('5:45')).toBe('2026-03-13T10:00:00+05:45');
    expect(at(-3)).toBe('2026-03-13T10:00:00-03:00');
    expect(at('0')).toBe('2026-03-13T10:00:00Z');
    expect(at('-3', '2026-03-13 10:00')).toBe('2026-03-13T10:00:00-03:00');
    for (const [timeZone, occurDate] of [[undefined, undefined], ['', undefined], ['America/Argentina/Buenos_Aires', undefined], ['+15', undefined], ['+3:60', undefined],
      ['-3', '2026-03-13T10:00:00'], ['-3', '13/03/2026 10:00'], ['-3', '2026-03-13 25:00:00'], ['-3', ''], ['-3', 1773406800000]] as const) {
      expect(() => parseLion(changed(p => { p.trackItemList.unshift(scan({ timeZone, occurDate })); }).data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it("stages a scan by its code, else by its step on the page's route rail", () => {
    const newest = (fields: Record<string, unknown>) => parseLion(changed(p => { p.trackItemList.unshift(scan(fields)); }).data, NUMBER);
    expect(newest({ icon: 'CUSTOMS' })).toMatchObject({ current_stage: 'customs', events: expect.arrayContaining([expect.objectContaining({ provider_code: 'WSD999', stage: 'customs', stage_source: 'carrier_map' })]) });
    // A rail step before the parcel moves does not take back the group's stage.
    expect(newest({ icon: 'HUB' })).toMatchObject({ current_stage: 'in_transit', events: expect.arrayContaining([expect.objectContaining({ provider_code: 'WSD999', stage: 'accepted' })]) });
    // A code it does not know and no rail step leave the scan without a stage, so the review sees it.
    const plain = newest({});
    expect(plain.events![0]).toEqual({ time: '2026-03-13T10:00:00-03:00', description: 'Synthetic wording', location: 'Argentina', provider_code: 'WSD999' });
    expect(plain.current_stage).toBe('in_transit');
    expect(newest({ icon: 'SYNTHETIC', trackCode: 'bad code' }).events![0]).toEqual({ time: '2026-03-13T10:00:00-03:00', description: 'Synthetic wording', location: 'Argentina' });
    for (const location of ['ZZ', 'XX', 'QO', 'Buenos Aires', 'EZEIZA', '', 7]) expect(newest({ location }).events![0]!.location).toBeUndefined();
    expect(() => newest({ oriDescription: '', description: ' ' })).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads where the parcel stands from the group it is filed under', () => {
    const filed = (groupCode: string, edit: (parcel: ReturnType<typeof fixture>) => void = () => {}) => parseLion(changed(p => { p.groupCode = groupCode; edit(p); }).data, NUMBER);
    const delivered = filed('DELIVERED', p => { p.trackItemList.unshift(scan({ occurDate: '2026-03-14 12:00:00', icon: 'DELIVERED', trackCode: 'WSD999' })); p.lastTrackStatusEn = 'Delivered'; });
    expect(delivered).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', last_status_text: 'Delivered', provider_code: 'DELIVERED',
      last_update: '2026-03-14T12:00:00-03:00', delivered_at: '2026-03-14T12:00:00-03:00' });
    // A delivery the group states without a delivery scan has no delivery moment.
    expect(filed('DELIVERED').delivered_at).toBeUndefined();
    expect(filed('DELIVERED').current_stage).toBe('delivered');
    expect(filed('RETURNED_BACK')).toMatchObject({ current_stage: 'returned', provider_code: 'RETURNED_BACK' });
    expect(filed('PRECESSING')).toMatchObject({ current_stage: 'in_transit' });
    expect(filed('PRECESSING', p => { p.trackItemList = []; delete p.lastTrackStatusEn; })).toEqual({ status: languageStageStatus('registered'), current_stage: 'registered',
      current_stage_source: 'carrier_map', last_status_text: 'Processing', provider_code: 'PRECESSING', destination_country: 'AR', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    // "Pre-alert" names no stage: the scans decide, and without one the reply says nothing it can read.
    expect(filed('WARNING')).toMatchObject({ current_stage: 'in_transit', provider_code: 'WARNING' });
    expect(() => filed('WARNING', p => { p.trackItemList = []; })).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => filed('WARNING', p => { p.trackItemList = [scan({})]; })).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // A delivery under a newer scan nothing stages may have been undone, so the parcel takes no stage from it.
    const undone = filed('WARNING', p => { p.trackItemList.unshift(scan({ occurDate: '2026-03-16 09:00:00' }), scan({ occurDate: '2026-03-14 12:00:00', icon: 'DELIVERED' })); });
    expect(undone).toMatchObject({ status: 'unknown', provider_code: 'WARNING', last_update: '2026-03-16T09:00:00-03:00' });
    expect(undone.current_stage).toBeUndefined();
    expect(undone.delivered_at).toBeUndefined();
    for (const unread of ['ALL', 'LOST', 'in_transit', '', 5]) expect(() => filed(unread as string)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // The page files a parcel out for delivery under no group: its scans decide, as under "Pre-alert".
    const unfiled = (edit: (parcel: ReturnType<typeof fixture>) => void = () => {}) => parseLion(changed(p => { delete p.groupCode; edit(p); }).data, NUMBER);
    const out = unfiled(p => { p.trackItemList.unshift(scan({ occurDate: '2026-03-14 12:00:00', icon: 'DISPATCH', trackCode: 'WSD06', description: 'out for delivery' })); p.lastTrackStatusEn = 'Out for delivery'; });
    expect(out).toMatchObject({ status: languageStageStatus('out_for_delivery'), current_stage: 'out_for_delivery', last_status_text: 'Out for delivery', last_update: '2026-03-14T12:00:00-03:00' });
    expect(out).not.toHaveProperty('provider_code');
    const quiet = unfiled(p => { delete p.lastTrackStatusEn; });
    expect(quiet).toMatchObject({ current_stage: 'in_transit', last_status_text: quiet.events![0]!.description });
    expect(() => unfiled(p => { p.trackItemList = [scan({})]; })).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => unfiled(p => { p.trackItemList = []; })).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // The status the card shows, else the group's own wording.
    expect(filed('IN_TRANSIT', p => { p.lastTrackStatusEn = '未知'; }).last_status_text).toBe('In transit.');
    expect(filed('IN_TRANSIT', p => { delete p.destinationCountryEn; }).destination_country).toBeUndefined();
  });

  it('never reads a proof of delivery, the route rail or the transit days', () => {
    const result = parseLion(changed(p => { p.podUrl = 'https://example.invalid/PRIVATE'; p.deliveredDay = 'PRIVATE'; p.trackSub.subDesc = 'PRIVATE'; p.consignee = 'PRIVATE'; }).data, NUMBER);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|example\.invalid/);
  });

  it('rejects a reply that names another parcel and a malformed one', () => {
    for (const own of ['WSHAR0000000002YQ', `${NUMBER}1`, `1${NUMBER}`, '', 42, null, [NUMBER]]) {
      expect(() => parseLion(changed(p => { p.hawbCode = own; }).data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseLion(changed(p => { p.hawbCode = 'wshar-0000000001yq'; }).data, NUMBER).events).toHaveLength(5);
    // The parcel is found by its code in a longer list.
    expect(parseLion(changed((p, d) => { d.data.trackList.unshift({ ...p, hawbCode: 'WSHAR0000000002YQ', groupCode: 'DELIVERED' }); }).data, NUMBER).current_stage).toBe('in_transit');
    for (const data of [changed(p => { p.trackItemList = {}; }), changed(p => { p.trackItemList = [null]; }), changed(p => { p.trackItemList = Array(301).fill(scan({})); }),
      changed((_p, d) => { d.data.trackList = {}; }), changed((_p, d) => { d.data.trackList = []; }), changed((_p, d) => { d.data.trackList = [null]; })]) {
      expect(() => parseLion(data.data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const data of [null, [], 'parcel', {}, { trackList: 'parcel' }]) expect(() => parseLion(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('tells a missing parcel from an error of the service, a refusal and a page', () => {
    expect(() => parseLionReply(200, JSON.stringify(missing()), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    // A missing-parcel answer for another number, or one with scans, is not this number's.
    expect(() => parseLionReply(200, JSON.stringify(missing('WSHAR0000000002YQ')), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    const listed = missing(); (listed.data.trackList[0] as Record<string, unknown>).trackItemList = [scan({})];
    expect(() => parseLionReply(200, JSON.stringify(listed), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLionReply(200, JSON.stringify({ msg: '访问过于频繁，请稍候再试', code: 500 }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'rate_limited' }));
    expect(() => parseLionReply(200, JSON.stringify({ msg: 'synthetic failure', code: 500 }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseLionReply(200, JSON.stringify({ msg: 'unauthorized', code: 401 }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseLionReply(404, JSON.stringify(missing()), NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseLionReply(200, '<!doctype html><html><head><title>360LION客户端</title></head><body><div id="app"></div></body></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLionReply(200, '<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseLionReply(200, JSON.stringify({ msg: 'operation successful', code: 200 }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(parseLionReply(200, JSON.stringify(fixture()), NUMBER).last_status_text).toBe('Transit in Destination Country');
  });

  it('maps every recorded code and group to its stage, and leaves the stageless groups as gaps', () => {
    for (const entry of statuses.entries) {
      const known = lionScan(entry.code) ?? lionGroup(entry.code)!;
      expect(known.en).toBe(entry.wording);
      expect(known.stage).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
      expect(STAGES).toContain(entry.stage);
    }
    expect(statusMapAnswer({ carrier: '360lion', providerCode: 'WSD02', description: 'Recibido(Ya recibió el paquete.)' })).toMatchObject({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: '360lion', providerCode: 'WARNING', description: 'Pre-alert' })).toMatchObject({ kind: 'intentional_gap' });
    expect(statusMapAnswer({ carrier: '360lion', providerCode: 'WSD999', description: 'Synthetic wording' })).toMatchObject({ kind: 'unknown' });
    expect(lionRail('DISPATCH')).toBe('in_transit');
    expect(lionRail('dispatch')).toBeUndefined();
    expect(statusMap.stage(null, 'arrived at airport')).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status, { 'retry-after': '60' }));
    await expect(new LionTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports the service's own missing-parcel reply as not found, and a page as a changed service", async () => {
    const absent = vi.fn<typeof fetch>().mockResolvedValue(response(missing()));
    await expect(new LionTracker({ fetcher: absent }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    expect(absent).toHaveBeenCalledOnce();
    const page = vi.fn<typeof fetch>().mockResolvedValue(response('<!doctype html><title>360LION客户端</title>', 200, { 'content-type': 'text/html' }));
    await expect(new LionTracker({ fetcher: page }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new LionTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new LionTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('routes an explicit selection', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const tracker = createTracker({ fetcher, env: {}, providers: [] });
    const result = await tracker.track({ carrier: '360lion', number: NUMBER });
    expect(result.source).toBe('360lion');
    expect(result.result.events).toHaveLength(5);
    expect(result.result.last_status_text).toBe('Transit in Destination Country');
    for (const number of ['', 'AR00001', 'WSH AR0000000001YQ', 'WSHAR0000000001YQ,AR0000000001', 'WSH-AR0000000001YQ', 'A'.repeat(41)]) expect(() => normalizeLionNumber(number)).toThrow();
    for (const number of [NUMBER, 'AR0000000001', 'wshar0000000001yq']) expect(normalizeLionNumber(` ${number} `)).toBe(number.toUpperCase());
  });
});

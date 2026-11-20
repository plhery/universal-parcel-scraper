import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionCandidates } from '../../core/catalog/recognition.js';
import { sameInstantIdentityPolicy } from '../../core/catalog/eventIdentity.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, MemphisTracker } from './adapter.js';
import { memphisUrl, normalizeMemphisNumber, parseMemphis, parseMemphisReply } from './parser.js';
import { memphisStage, statusMap } from './status.js';

const NUMBER = 'M9999991MIA';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/tracking.json', import.meta.url), 'utf8'));
const changed = (edit: (house: ReturnType<typeof fixture>, data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data.items[0], data); return data; };
const response = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code: string; wording: string; stage: string }[] };
// The service's answer for a code it does not know, as it came for another carrier's public number.
const MISSING = { success: true, items: [] };
const scan = (fields: Record<string, unknown>) => ({ code: 'SYN', date: '2026-03-13T10:00:00', description: 'Synthetic wording', comments: '', location: null, ...fields });
const direct = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Memphis Courier guest adapter', () => {
  it('asks for the whole code once, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new MemphisTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.events).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://testapi.bitechsolucoes.com.br/api/tracking/found-house?account=&trackingNumber=${NUMBER}`);
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: { Accept: 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(init!.method).toBeUndefined();
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'memphis-courier', step: 'direct', outcome: 'ok' }));
    expect(memphisUrl('AB/12')).toBe('https://testapi.bitechsolucoes.com.br/api/tracking/found-house?account=&trackingNumber=AB%2F12');
  });

  it('reads the scans newest first on their wall clocks, staged by their codes', () => {
    expect(parseMemphis(fixture(), NUMBER)).toEqual({ status: languageStageStatus('in_transit'), current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Encomenda em transferência', expected_delivery: null, weight_kg: 0.75, last_update: null, last_update_local: '2026-03-12T09:15:00',
      events: [
        { local_time: '2026-03-12T09:15:00', description: 'Encomenda em transferência', provider_code: 'TRA', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-10T07:20:11.500', description: 'Encomenda em trânsito', provider_code: 'ENO', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-09T06:05:42', description: 'Entrada registrada no Centro de Distribuição', provider_code: 'CHK', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2026-03-03T14:30:27.123', description: 'Seu pedido foi criado com sucesso', provider_code: 'FLT', stage: 'registered', stage_source: 'carrier_map' },
      ] });
    // Rows out of order are put newest first; rows of one clock keep the reply's order.
    const shuffled = parseMemphis(changed(h => { h.events.reverse(); }), NUMBER);
    expect(shuffled.events!.map(event => event.provider_code)).toEqual(['TRA', 'ENO', 'CHK', 'FLT']);
    const tied = parseMemphis(changed(h => { h.events[1].date = h.events[2].date; }), NUMBER);
    expect(tied.events!.slice(1, 3).map(event => event.provider_code)).toEqual(['ENO', 'CHK']);
    // A clock that states its offset is an instant; a place the page shows is kept.
    const zoned = parseMemphis(changed(h => { h.events.unshift(scan({ code: 'DLV', date: '2026-03-14T12:00:00-03:00', location: 'SP' })); }), NUMBER);
    expect(zoned).toMatchObject({ current_stage: 'delivered', status: languageStageStatus('delivered'), last_update: '2026-03-14T12:00:00-03:00' });
    expect(zoned.events![0]).toEqual({ time: '2026-03-14T12:00:00-03:00', description: 'Synthetic wording', location: 'SP', provider_code: 'DLV', stage: 'delivered', stage_source: 'carrier_map' });
    expect(zoned.last_update_local).toBeUndefined();
  });

  it('keeps a clock\'s fraction of a second, and two scans apart by one', () => {
    const twice = parseMemphis(changed(h => {
      h.events.unshift(scan({ date: '2026-03-13T10:00:00.6' }), scan({ date: '2026-03-13T10:00:00' }));
    }), NUMBER);
    expect(twice.events!.slice(0, 2).map(event => event.local_time)).toEqual(['2026-03-13T10:00:00.600', '2026-03-13T10:00:00']);
    expect(twice.last_update_local).toBe('2026-03-13T10:00:00.600');
    // Seven digits keep their milliseconds; a fraction of zeros is the whole second.
    const fine = parseMemphis(changed(h => { h.events.unshift(scan({ date: '2026-03-13T10:00:00.1234567' }), scan({ date: '2026-03-13T09:00:00.000-03:00' })); }), NUMBER);
    expect(fine.events![0]!.local_time).toBe('2026-03-13T10:00:00.123');
    expect(fine.events!.find(event => event.time)!.time).toBe('2026-03-13T09:00:00-03:00');
    const zoned = parseMemphis(changed(h => { h.events.unshift(scan({ date: '2026-03-14T12:00:00.25-03:00' })); }), NUMBER);
    expect(zoned.events![0]!.time).toBe('2026-03-14T12:00:00.250-03:00');
    // The same scan stored on the whole second is the scan with its fraction.
    const policy = sameInstantIdentityPolicy('memphis-courier', { supportsScanMatching: true });
    expect(policy).toMatchObject({ matchWithinMinute: true });
    const stored = { stage: 'in_transit', description: 'Encomenda em trânsito', location: '', providerCode: 'ENO' };
    expect(policy?.matches?.({ ...stored, description: ' Encomenda em  trânsito ' }, stored)).toBe(true);
    for (const other of [{ ...stored, providerCode: 'TRA' }, { ...stored, location: 'SP' }, { ...stored, description: 'Encomenda em transferência' }]) {
      expect(policy?.matches?.(other, stored)).toBe(false);
    }
  });

  it('rejects a scan whose clock or wording it cannot read', () => {
    for (const date of [undefined, '', '2026-03-13 10:00:00', '13/03/2026 10:00', '2026-03-13T25:00:00', '2026-02-30T10:00:00', 1773406800000]) {
      expect(() => parseMemphis(changed(h => { h.events.unshift(scan({ date })); }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseMemphis(changed(h => { h.events.unshift(scan({ description: ' ' })); }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('leaves a code it does not know without a stage, and the parcel at its newest known one', () => {
    const plain = parseMemphis(changed(h => { h.events.unshift(scan({}), scan({ code: 'not a code', date: '2026-03-13T11:00:00' })); }), NUMBER);
    expect(plain.events!.slice(0, 2)).toEqual([{ local_time: '2026-03-13T11:00:00', description: 'Synthetic wording' },
      { local_time: '2026-03-13T10:00:00', description: 'Synthetic wording', provider_code: 'SYN' }]);
    expect(plain).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Synthetic wording', last_update_local: '2026-03-13T11:00:00' });
    expect(parseMemphis(changed(h => { h.events = [scan({})]; }), NUMBER)).toMatchObject({ status: 'unknown', last_status_text: 'Synthetic wording' });
    // A delivery under a newer code the map does not know may have been undone, so the shipment takes no stage from it.
    const undone = parseMemphis(changed(h => { h.events.unshift(scan({ date: '2026-03-14T09:00:00' }), scan({ code: 'DLV', date: '2026-03-13T10:00:00' })); }), NUMBER);
    expect(undone).toMatchObject({ status: 'unknown', last_update_local: '2026-03-14T09:00:00' });
    expect(undone.current_stage).toBeUndefined();
    expect(parseMemphis(changed(h => { h.events = []; }), NUMBER)).toEqual({ status: 'unknown', last_status_text: '', expected_delivery: null, weight_kg: 0.75,
      last_update: null, summary_only: true, events: [] });
    // A repeated row is listed once.
    expect(parseMemphis(changed(h => { h.events.push({ ...h.events[3] }); }), NUMBER).events).toHaveLength(4);
  });

  it('never reads the destination, the comments, the customs papers or the account', () => {
    const result = parseMemphis(changed(h => {
      h.destCep = 'PRIVATE'; h.destMunicipio = 'PRIVATE'; h.destEstado = 'PRIVATE'; h.houseCode = 'PRIVATE'; h.anvisa = 'PRIVATE';
      h.events[0].comments = 'PRIVATE'; h.account = 'PRIVATE';
    }), NUMBER);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Cidade Exemplo|00000-000/);
    for (const totalWeight of [0, -1, '0.75', null, Number.NaN, 20_000]) expect(parseMemphis(changed(h => { h.totalWeight = totalWeight; }), NUMBER).weight_kg).toBeUndefined();
  });

  it('rejects a reply that names another shipment and a malformed one', () => {
    for (const own of ['M9999992MIA', `${NUMBER}1`, `1${NUMBER}`, '', 42, null, [NUMBER]]) {
      expect(() => parseMemphis(changed(h => { h.codigo = own; }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parseMemphis(changed(h => { h.codigo = 'm 9999991 mia'; }), NUMBER).events).toHaveLength(4);
    // The shipment is found by its code in a longer list.
    expect(parseMemphis(changed((h, d) => { d.items.unshift({ ...h, codigo: 'M9999992MIA', events: [scan({ code: 'DLV' })] }); }), NUMBER).current_stage).toBe('in_transit');
    for (const data of [changed(h => { h.events = {}; }), changed(h => { h.events = [null]; }), changed(h => { h.events = Array(301).fill(scan({})); }),
      changed((_h, d) => { d.items = {}; }), changed((_h, d) => { d.items = [null]; }), changed((_h, d) => { d.success = 'true'; })]) {
      expect(() => parseMemphis(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    }
    for (const data of [null, [], 'shipment', {}, { success: true }]) expect(() => parseMemphis(data, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('tells a missing shipment from an error of the service, a moved service and a page', () => {
    expect(() => parseMemphisReply(200, JSON.stringify(MISSING), NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseMemphisReply(200, JSON.stringify({ success: false, messages: ['synthetic failure'] }), NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseMemphisReply(404, JSON.stringify(MISSING), NUMBER)).toThrowError(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseMemphisReply(200, '<!doctype html><html><head><title>ShipmentTracking</title></head><body><app-root></app-root></body></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseMemphisReply(200, '<html><head><title>Just a moment...</title></head></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    expect(parseMemphisReply(200, JSON.stringify(fixture()), NUMBER).last_status_text).toBe('Encomenda em transferência');
  });

  it('maps every recorded code to its stage', () => {
    for (const entry of statuses.entries) {
      expect(memphisStage(entry.code)).toBe(entry.stage);
      expect(statusMap.stage(entry.code, entry.wording.toLowerCase())).toBe(entry.stage);
      expect(STAGES).toContain(entry.stage);
    }
    expect(statusMapAnswer({ carrier: 'memphis-courier', providerCode: 'ENO', description: 'Encomenda em trânsito' })).toMatchObject({ kind: 'mapped', stage: 'in_transit' });
    expect(statusMapAnswer({ carrier: 'memphis-courier', providerCode: 'SYN', description: 'Synthetic wording' })).toMatchObject({ kind: 'unknown' });
    expect(statusMap.stage(null, 'encomenda em trânsito')).toBeUndefined();
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i without another request', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, status, { 'retry-after': '60' }));
    await expect(new MemphisTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 60_000 } : {}) });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('honors cancellation before I/O and in a pending request', async () => {
    const before = new AbortController(); before.abort(); const never = vi.fn();
    expect(() => new MemphisTracker({ fetcher: never }).fetch(NUMBER, { signal: before.signal })).toThrow();
    expect(never).not.toHaveBeenCalled();
    const during = new AbortController();
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }); during.abort(new Error('synthetic cancellation'));
    });
    await expect(new MemphisTracker({ fetcher }).fetch(NUMBER, { signal: during.signal })).rejects.toThrow('synthetic cancellation');
  });

  it('recognizes a shipment the tracker lists under the code, and not a missing one', async () => {
    await expect(direct(vi.fn<typeof fetch>().mockResolvedValue(response(fixture()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    await expect(direct(vi.fn<typeof fetch>().mockResolvedValue(response(MISSING))).recognize!(NUMBER)).resolves.toMatchObject({ known: false });
    const never = vi.fn<typeof fetch>();
    await expect(direct(never).recognize!('M-1')).resolves.toMatchObject({ known: false });
    expect(never).not.toHaveBeenCalled();
    await expect(direct(vi.fn<typeof fetch>().mockResolvedValue(response({}, 429))).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('routes an explicit selection, and recognition asks it about its layout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()));
    const tracker = createTracker({ fetcher, env: {}, providers: [] });
    const result = await tracker.track({ carrier: 'memphis-courier', number: NUMBER });
    expect(result.source).toBe('memphis-courier');
    expect(result.result.events).toHaveLength(4);
    expect(recognitionCandidates(NUMBER).map(candidate => candidate.carrier)).toContain('memphis-courier');
    expect(recognitionCandidates('M99999991MIA').map(candidate => candidate.carrier)).not.toContain('memphis-courier');
    for (const number of ['', 'M-1', 'M9999991MIA,M9999992MIA', 'M9999991-MIA', 'A'.repeat(31)]) expect(() => normalizeMemphisNumber(number)).toThrow();
    for (const number of [NUMBER, 'm 9999991 mia']) expect(normalizeMemphisNumber(` ${number} `)).toBe(NUMBER);
  });
});

it('orders explicit offsets by instant and keeps incomparable scans in sequence', () => {
  const delivery = scan({ code: 'DLV', date: '2026-03-14T10:00:00-03:00' });
  const transit = scan({ code: 'TRA', date: '2026-03-14T11:00:00Z' });
  const read = (events: unknown[]) => parseMemphis(changed(h => { h.events = events; }), NUMBER);
  expect(read([transit, delivery]).current_stage).toBe('delivered');
  const wall = scan({ code: 'TRA', date: '2026-03-14T09:00:00' });
  expect(read([wall, delivery]).current_stage).toBe('in_transit');
});

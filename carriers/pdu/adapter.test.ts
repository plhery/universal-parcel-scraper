import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, PduTracker } from './adapter.js';
import { normalizePduNumber, parsePdu, PDU_ENDPOINT, pduJson } from './parser.js';
import { pduStage, statusMap } from './status.js';

const NUMBER = 'CO00000001PD';
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/shipment.json', import.meta.url), 'utf8'));
const changed = (edit: (data: ReturnType<typeof fixture>) => void) => { const data = fixture(); edit(data); return data; };
const response = (data: unknown, status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { code?: string; wording?: string; stage: string }[] };
const unknownReply = (tracks: unknown[], nonExists = 1) => changed(d => { d.data.orderTracks = tracks; d.data.orderTrackStatus.nonExists = nonExists; });

describe('PDU guest adapter', () => {
  it('posts the number once as the page does, with the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new PduTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(` ${NUMBER.toLowerCase()} `, { budgetMs: 4000 });
    expect(result.current_stage).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(PDU_ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(JSON.parse(init!.body as string)).toEqual([NUMBER]);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'pdu', step: 'direct', outcome: 'ok' }));
  });

  it('reads the scans newest first, on the offset PDU states for each wall clock', () => {
    const result = parsePdu(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado', last_update: '2026-03-12T15:20:00-05:00', delivered_at: '2026-03-12T15:20:00-05:00', expected_delivery: null });
    expect(result.events!.map(event => [event.time, event.description, event.provider_code, event.stage])).toEqual([
      ['2026-03-12T15:20:00-05:00', 'Entregado', 'SIGNED', 'delivered'],
      ['2026-03-12T07:05:00-05:00', 'Salida a Ruta', 'DELIVERY', 'out_for_delivery'],
      ['2026-03-10T20:40:00-05:00', 'En tránsito nacional', 'DELIVERY', 'in_transit'],
      ['2026-03-10T10:10:00-05:00', 'Ingreso a CEDI', 'FINAL_COLLECTING', 'in_transit'],
      ['2026-03-09T09:30:00-05:00', 'Recogida en Aduanas', 'COLLECTING', 'in_transit'],
      ['2026-02-25T11:00:00+08:00', 'Shipment information sent to PDU.', 'TRANSIT', 'registered'],
      ['2026-02-24T21:15:00-05:00', 'Package not found in last mile or customs process.', 'TRANSIT', 'registered'],
    ]);
    expect(result.events![0]).toMatchObject({ original_description: 'ENT,Entregado', stage_source: 'carrier_map' });
    expect(result.events![5]).not.toHaveProperty('original_description');
  });

  it('orders scans by instant across offsets and dates a scan without an offset by its Beijing clock', () => {
    const result = parsePdu(changed(d => {
      const rows = d.data.orderTracks[0].trackDetailList;
      d.data.orderTracks[0].trackDetailList = [rows[6], rows[5]];
      d.data.orderTracks[0].trackStatus = 'TRANSIT';
    }), NUMBER);
    expect(result.events!.map(event => event.time)).toEqual(['2026-02-25T11:00:00+08:00', '2026-02-24T21:15:00-05:00']);
    const bare = parsePdu(changed(d => { d.data.orderTracks[0].trackDetailList[0].trackTimeZone = null; }), NUMBER);
    expect(bare.events![0]).toMatchObject({ time: '2026-03-13T04:20:00+08:00', description: 'Entregado' });
    expect(bare.events![0]).not.toHaveProperty('local_time');
    expect(() => parsePdu(changed(d => { Object.assign(d.data.orderTracks[0].trackDetailList[0], { trackTimeZone: null, trackCnTime: null }); }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parsePdu(changed(d => { d.data.orderTracks[0].trackDetailList[0].trackTimeZone = 'UTC+5:30'; }), NUMBER).events!.find(event => event.description === 'Entregado')!.time)
      .toBe('2026-03-12T15:20:00+05:30');
  });

  it('keeps a delivery round in transit unless its wording says the round began', () => {
    const result = parsePdu(changed(d => {
      const track = d.data.orderTracks[0];
      track.trackStatus = 'DELIVERY';
      track.trackDetailList = track.trackDetailList.slice(2);
    }), NUMBER);
    expect(result).toMatchObject({ current_stage: 'in_transit', last_status_text: 'En tránsito nacional' });
    expect(pduStage('DELIVERY', 'Unmapped wording')).toBe('in_transit');
    expect(pduStage('DELIVERY', 'salida a ruta')).toBe('out_for_delivery');
  });

  it("takes the parcel's final state when no scan carries it", () => {
    const result = parsePdu(changed(d => {
      const track = d.data.orderTracks[0];
      track.trackStatus = 'RETURNED';
      track.trackDetailList = track.trackDetailList.slice(1);
    }), NUMBER);
    expect(result).toMatchObject({ current_stage: 'returned', last_status_text: 'Returned', provider_code: 'RETURNED' });
  });

  it('reports a number PDU does not know as not found, and nothing else', () => {
    const unknownTrack = { serviceTrackingNumber: NUMBER, trackStatus: null, trackDetailList: [] };
    expect(() => parsePdu(unknownReply([unknownTrack]), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePdu(unknownReply([{ ...unknownTrack, trackStatus: 'NOT_FOUND' }]), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePdu(unknownReply([]), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parsePdu(unknownReply([], 0), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parsePdu(unknownReply([{ ...unknownTrack, trackStatus: 'TRANSIT' }]), NUMBER)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parsePdu({ code: 500, success: false, msg: 'error' }, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it("binds the reply to the whole number", () => {
    const other = changed(d => { d.data.orderTracks[0].serviceTrackingNumber = 'CO00000002PD'; });
    expect(() => parsePdu(other, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const both = changed(d => { d.data.orderTracks.unshift({ ...d.data.orderTracks[0], serviceTrackingNumber: 'CO00000002PD', trackStatus: 'RETURNED' }); });
    expect(parsePdu(both, NUMBER).current_stage).toBe('delivered');
  });

  it('rejects changed replies and verification pages rather than calling them missing', async () => {
    expect(() => parsePdu(changed(d => { d.data.orderTracks[0].trackDetailList[0].trackRealTime = '12/03/2026'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePdu(changed(d => { d.data.orderTracks[0].trackStatus = 'LOST_IN_SPACE'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePdu(changed(d => { d.data.orderTracks[0].trackDetailList = {}; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parsePdu({ success: true, code: 200, data: {} }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => pduJson('<html><title>Just a moment...</title></html>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => pduJson('<html><body>maintenance</body></html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const limited = vi.fn<typeof fetch>().mockResolvedValue(response('slow down', 429));
    await expect(new PduTracker({ fetcher: limited }).fetch(NUMBER)).rejects.not.toMatchObject({ kind: 'not_found' });
    expect(() => normalizePduNumber('CO-1')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('maps every recorded state and wording as its statuses say', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(entry.code ?? null, entry.wording ?? ''), `${entry.code ?? ''} ${entry.wording ?? ''}`).toBe(entry.stage);
    }
  });

  it('recognizes by the waybill inquiry: an unknown number is unknown, a listed waybill known', async () => {
    const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
    const empty = vi.fn<typeof fetch>().mockImplementation(async () => response(unknownReply([])));
    await expect(carrier(empty).recognize!(NUMBER)).resolves.toEqual({ known: false });
    expect(empty).toHaveBeenCalledOnce();
    await expect(carrier(vi.fn<typeof fetch>().mockImplementation(async () => response(fixture()))).recognize!(NUMBER)).resolves.toMatchObject({ known: true });
    const unused = vi.fn<typeof fetch>();
    await expect(carrier(unused).recognize!('CO-1')).resolves.toEqual({ known: false });
    expect(unused).not.toHaveBeenCalled();
    const blocked = vi.fn<typeof fetch>().mockImplementation(async () => response('<html><title>Just a moment...</title></html>'));
    await expect(carrier(blocked).recognize!(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('is asked about its numbers, whose closing letters Colis Privé never prints', () => {
    expect(recognitionAskedCarriers(NUMBER)).toContain('pdu');
    expect(recognitionAskedCarriers(NUMBER)).not.toContain('colis-prive');
  });

  it('offers PDU for its numbers without claiming other layouts', () => {
    expect(detectCarrierMatch(NUMBER)?.candidates).toContain('pdu');
    for (const other of ['CO0000000PD', 'CO000000001PD', 'CO00000001PE', 'C000000001PD']) {
      expect(detectCarrierMatch(other)?.candidates ?? [], other).not.toContain('pdu');
    }
  });
});

it('reports a missing tracking endpoint as a transport failure', async () => {
  for (const status of [404, 410]) {
    const fetcher = async () => new Response(null, { status });
    const tracker = new PduTracker({ fetcher });
    await expect(tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
  }
});

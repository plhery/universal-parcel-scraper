import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, PAKET_PAGE, paketLookupUrl, PaketTracker } from './adapter.js';
import { isPaketNotFound, normalizePaketNumber, parsePaket } from './parser.js';
import { PAKET_LOST, paketAlert, paketStage, paketStep, statusMap } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// The public sample: an order a shop booked in the Santiago Metropolitan region, delivered the same day.
const ITEM = numbers.records[0]!.number;
// A synthetic number of the same shape, which the tracker does not know.
const UNKNOWN = '970318264';

type Row = Record<string, unknown>;
type Reply = { success: boolean; data: Record<string, unknown> & { envio: Row; historial: Row[]; progreso: Row; estado_info: Row } };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Reply;
const edited = (change: (reply: Reply) => void, name = 'delivered') => {
  const reply = fixture(name);
  change(reply);
  return reply;
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const once = (response: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(response);
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const GOOGLE_404 = '<!DOCTYPE html><html lang=en><title>Error 404 (Not Found)!!1</title><p><b>404.</b> That’s an error.</html>';

describe('Paket tracking adapter', () => {
  it('asks the tracker for the whole number from the tracking page\'s origin, through the supplied transport', async () => {
    const fetcher = once(json(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new PaketTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${ITEM} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`https://paket-api-47404721744.southamerica-west1.run.app/envios/tracking.php?id=${ITEM}`);
    expect(url).toBe(paketLookupUrl(ITEM));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'application/json', Origin: 'https://track.paket.cl', Referer: PAKET_PAGE, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'paket-cl', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s rows on Santiago\'s clock, staged by their state codes', () => {
    const result = parsePaket(fixture('delivered'), ITEM);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Tu pedido fue entregado', last_update: '2026-05-15T15:41:58-04:00', last_update_local: '2026-05-15T15:41:58',
      expected_delivery: null,
      events: [
        { time: '2026-05-15T15:41:58-04:00', local_time: '2026-05-15T15:41:58', time_zone: 'America/Santiago', time_zone_basis: 'carrier',
          description: 'Tu pedido fue entregado', provider_code: '5', stage: 'delivered', stage_source: 'carrier_map' },
        { time: '2026-05-15T14:00:46-04:00', local_time: '2026-05-15T14:00:46', time_zone: 'America/Santiago', time_zone_basis: 'carrier',
          description: 'Tu pedido está en reparto', provider_code: '4', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { time: '2026-05-15T12:20:53-04:00', local_time: '2026-05-15T12:20:53', time_zone: 'America/Santiago', time_zone_basis: 'carrier',
          description: 'Paket retiró este pedido', provider_code: '2', stage: 'accepted', stage_source: 'carrier_map' },
        { time: '2026-05-15T00:14:44-04:00', local_time: '2026-05-15T00:14:44', time_zone: 'America/Santiago', time_zone_basis: 'carrier',
          description: 'Paket aún no retira este pedido', provider_code: '1', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads a summer clock on Chile\'s summer offset, never a fixed one', () => {
    const summer = parsePaket(edited((reply) => { reply.data.historial[0]!.fecha = '2027-01-15 15:41:58'; }), ITEM);
    expect(summer.events![0]).toMatchObject({ time: '2027-01-15T15:41:58-03:00', local_time: '2027-01-15T15:41:58', time_zone: 'America/Santiago' });
  });

  it('never reads the recipient, the commune, the note, the map point, the photos or the shop', () => {
    const result = parsePaket(edited((reply) => {
      Object.assign(reply.data.envio, { nombre: 'RECIPIENT NAME', direccion: 'RECIPIENT STREET 1', telefono: '+56900000000',
        telefono_masked: '9XXXX0000', comuna: 'RECIPIENT TOWN', nota: 'RECIPIENT NOTE', referencia: 'SHOP-REF' });
      Object.assign(reply.data, { masked: false, firmado: true, pictures: [{ url: 'https://photos.example/recipient.jpg' }],
        ubicacion: { lat: -33.4, lng: -70.6 }, tienda: { nombre_tienda: 'SHOP NAME' }, correccion: { indicaciones: 'RECIPIENT DIRECTIONS' } });
    }), ITEM);
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT|SHOP|\+569|9XXXX|example|-33\.4|-70\.6|Comuna|Tienda/);
    for (const field of ['receiver_name', 'receiver_address', 'signed_by', 'sender_name', 'pickup_point']) expect(result).not.toHaveProperty(field);
  });

  it('reads the tracker\'s 404 for a number it does not know as not found, and binds the answer to the number asked', async () => {
    expect(isPaketNotFound(fixture('not-found'))).toBe(true);
    await expect(carrier(once(json(fixture('not-found'), 404))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
    // Another message, a found reply's data beside the message, or the message without a 404 say nothing about the number.
    await expect(carrier(once(json({ success: false, error: 'Error interno' }, 404))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(once(json({ ...fixture('not-found'), data: fixture('delivered').data }, 404))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(carrier(once(json(fixture('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    // The reply for another number, as a cache could give it, is no answer.
    expect(() => parsePaket(fixture('delivered'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    // The tracker reads the number as a whole number: asked with a leading zero, it repeats it without.
    expect(parsePaket(fixture('delivered'), `0${ITEM}`)).toMatchObject({ status: 'delivered' });
    expect(parsePaket(edited((reply) => { reply.data.envio.id = String(reply.data.envio.id); }), ITEM)).toMatchObject({ status: 'delivered' });
    expect(() => parsePaket(edited((reply) => { reply.data.envio.id = `${String(reply.data.envio.id)}1`; }), ITEM))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('takes the page\'s headline for a parcel with an alert or one Paket is looking for', () => {
    const alerted = (alerta: unknown) => parsePaket(edited((reply) => { reply.data.progreso.alerta = alerta; }), ITEM);
    expect(alerted('fallido')).toMatchObject({ status: 'exception', current_stage: 'failed_attempt', current_stage_source: 'carrier_map',
      last_status_text: 'No pudimos entregarlo', last_update_local: '2026-05-15T15:41:58' });
    expect(alerted('no_recibido')).toMatchObject({ current_stage: 'exception', last_status_text: 'Paket no tiene este pedido' });
    expect(alerted('devolviendo')).toMatchObject({ current_stage: 'exception', last_status_text: 'Tu pedido va de vuelta a la tienda' });
    expect(alerted('devuelto')).toMatchObject({ current_stage: 'returned', last_status_text: 'Tu pedido volvió a la tienda' });
    // An alert that names no stage, or one the page does not know, leaves the rows to decide.
    for (const alerta of ['consultar', 'otra', null]) {
      expect(alerted(alerta), String(alerta)).toMatchObject({ current_stage: 'delivered', last_status_text: 'Tu pedido fue entregado' });
    }
    expect(() => alerted({ codigo: 'fallido' })).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(parsePaket(edited((reply) => { reply.data.extraviado = { es_extraviado: true }; reply.data.progreso.alerta = 'devuelto'; }), ITEM))
      .toMatchObject({ status: 'exception', current_stage: 'exception', last_status_text: 'Estamos buscando tu pedido' });
  });

  it('stands a shipment without rows on its state code, its alert or the rail\'s step', () => {
    const bare = (change: (reply: Reply) => void) => parsePaket(edited((reply) => { reply.data.historial = []; change(reply); }), ITEM);
    expect(bare(() => undefined)).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      provider_code: '5', last_status_text: 'Tu pedido fue entregado', last_update: null, expected_delivery: null, summary_only: true, events: [] });
    expect(bare((reply) => { reply.data.progreso.alerta = 'fallido'; })).toMatchObject({ current_stage: 'failed_attempt',
      last_status_text: 'No pudimos entregarlo', summary_only: true });
    // A state the map does not know falls to the rail: step 2 is En bodega.
    expect(bare((reply) => { reply.data.envio.estado = '3'; reply.data.progreso.paso = 2; reply.data.estado_info = { titulo: 'En bodega' }; }))
      .toMatchObject({ status: 'in_transit', current_stage: 'in_transit', provider_code: '3', last_status_text: 'En bodega', summary_only: true });
    expect(() => bare((reply) => { reply.data.envio.estado = '9'; reply.data.progreso.paso = null; }))
      .toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(parsePaket(edited((reply) => { reply.data.historial = null as never; }), ITEM)).toMatchObject({ summary_only: true });
  });

  it('leaves a row of a state the map does not know to the wording rules and turns an oldest-first history round', () => {
    const noted = parsePaket(edited((reply) => {
      reply.data.historial.unshift({ id: 1, fecha: '2026-05-16 09:00:00', estado: 9, titulo: 'Nota', descripcion: 'Nota sintética' });
    }), ITEM);
    expect(noted.events![0]).toEqual({ time: '2026-05-16T09:00:00-04:00', local_time: '2026-05-16T09:00:00', time_zone: 'America/Santiago',
      time_zone_basis: 'carrier', description: 'Nota sintética', provider_code: '9' });
    // A row without a stage after the delivery may have undone it: the rail's step decides, else nothing.
    expect(noted).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Nota sintética', last_update_local: '2026-05-16T09:00:00' });
    const unrailed = parsePaket(edited((reply) => {
      reply.data.historial.unshift({ id: 1, fecha: '2026-05-16 09:00:00', estado: 9, titulo: 'Nota', descripcion: 'Nota sintética' });
      reply.data.progreso.paso = null;
    }), ITEM);
    expect(unrailed.status).toBe('unknown');
    expect(unrailed).not.toHaveProperty('current_stage');
    expect(paketStage('9', 'Tu pedido fue entregado')).toMatchObject({ stage: 'delivered' });
    expect(paketStage('9', 'Nota sintética')).toBeNull();
    // A row without a sentence keeps its title.
    expect(parsePaket(edited((reply) => { reply.data.historial[0]!.descripcion = null; }), ITEM).events![0])
      .toMatchObject({ description: 'Entregado', stage: 'delivered' });
    const reversed = parsePaket(edited((reply) => { reply.data.historial.reverse(); }), ITEM).events!;
    expect(reversed.map((event) => event.provider_code)).toEqual(['5', '4', '2', '1']);
  });

  it('refuses a changed reply', () => {
    const date = (value: unknown) => edited((reply) => { reply.data.historial[0]!.fecha = value; });
    for (const bad of ['15-05-2026 15:41:58', '2026-02-30 15:41:58', '2026-05-15 24:00:00', '2026-05-15 15:41', '2026-05-15T15:41:58-04:00', '', null, 1778874118]) {
      expect(() => parsePaket(date(bad), ITEM), String(bad)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(parsePaket(date('2026-05-15 15:41:58.812'), ITEM).events![0]).toMatchObject({ local_time: '2026-05-15T15:41:58' });
    for (const reply of [
      null, [], { success: 'true' }, { success: true }, { success: true, data: null }, { success: true, data: { envio: null } },
      edited((value) => { delete value.data.envio.id; }),
      edited((value) => { value.data.envio.id = { id: 1 }; }),
      edited((value) => { value.data.envio.id = -1; }),
      edited((value) => { value.data.historial = {} as never; }),
      edited((value) => { value.data.historial[0] = 'Entregado' as never; }),
      edited((value) => { value.data.historial[0]!.descripcion = ''; value.data.historial[0]!.titulo = ''; }),
      edited((value) => { value.data.historial[0]!.descripcion = { texto: 'Entregado' }; }),
      edited((value) => { value.data.historial[0]!.estado = 'cinco'; }),
      edited((value) => { value.data.progreso = 'Entregado' as never; }),
      edited((value) => { value.data.historial = Array.from({ length: 201 }, () => value.data.historial[0]!); }),
    ]) {
      expect(() => parsePaket(reply, ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps browser checks, refusals, moved routes, outages and rate limits apart from a missing parcel, and retries a network failure once', async () => {
    const reading = (response: Response) => carrier(once(response)).track({ number: ITEM });
    await expect(reading(page(BLOCKED))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page(BLOCKED, 404))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(page('', 403))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(reading(json('', 429))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(reading(page('<html><title>Service Unavailable</title></html>', 503))).rejects.toMatchObject({ kind: 'maintenance' });
    await expect(reading(json({ success: false, error: 'Error interno' }, 500))).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(reading(page(GOOGLE_404, 404))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(page('', 302, { Location: 'https://track.paket.cl/' }))).rejects.toMatchObject({ kind: 'transport' });
    await expect(reading(page('<html><title>Paket</title></html>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json('{"success":'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json('{"success":', 404))).rejects.toMatchObject({ kind: 'schema' });
    await expect(reading(json({ success: false, error: 'Error interno' }))).rejects.toMatchObject({ kind: 'indeterminate' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes 4 to 12 digits and refuses anything else before a request', async () => {
    expect(normalizePaketNumber(' 9703 1826-4 ')).toBe(UNKNOWN);
    expect(normalizePaketNumber('0042')).toBe('0042');
    for (const bad of ['123', '1234567890123', 'PK970318264', '970318264/1', '', 'X'.repeat(65)]) {
      expect(() => normalizePaketNumber(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'PK970318264' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded state, alert and the lost flag to its stage', () => {
    expect(STATUS_MAPS['paket-cl']).toBe(statusMap);
    for (const entry of statuses.entries) {
      const stage = 'stage' in entry ? entry.stage : undefined;
      if (/^\d+$/.test(entry.code)) {
        expect(statusMap.stage(entry.code, normalizeStatusWording(entry.wording)), entry.code).toBe(stage);
        expect(paketStage(entry.code, entry.wording), entry.code).toEqual({ stage, source: 'carrier_map' });
      } else if (entry.code === 'extraviado') {
        expect(PAKET_LOST).toEqual({ stage, label: entry.wording });
      } else {
        expect(paketAlert(entry.code), entry.code).toEqual(stage ? { stage, label: entry.wording } : { label: entry.wording });
      }
    }
    expect(statusMap.stage('3', normalizeStatusWording('Tu pedido está en bodega'))).toBeUndefined();
    expect(statusMap.stage(null, normalizeStatusWording('Tu pedido fue entregado'))).toBeUndefined();
    expect([0, 1, 2, 3, 4, 5].map((step) => paketStep(step)?.stage))
      .toEqual(['registered', 'accepted', 'in_transit', 'out_for_delivery', 'delivered', undefined]);
  });
});

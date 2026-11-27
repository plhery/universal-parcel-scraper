import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { UpstreamNetworkError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, SZENDEX_TRACKER, SzendexTracker } from './adapter.js';
import { normalizeSzendexNumber, parseSzendex } from './parser.js';
import { statusMap, szendexMappedStage, szendexStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

const SHIPMENT = numbers.records[0]!.number;
// The service order the sample's page names: its first twelve digits.
const ORDER = SHIPMENT.slice(0, 12);
const UNKNOWN = '999999999999999999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const shipment = () => fixture(`shipment-${SHIPMENT}`);
const reply = (body: string, status = 200) => new Response(status === 204 ? null : body,
  { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const madrid = (local: string, offset: string) => ({ local_time: local, time: `${local}${offset}`, time_zone: 'Europe/Madrid', time_zone_basis: 'carrier' });

describe('Szendex HTTP adapter', () => {
  it('asks the tracker for the whole number as szendex.com does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(shipment()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new SzendexTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${SHIPMENT} `, { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SZENDEX_TRACKER}?seg=${SHIPMENT}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'szendex', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the history on Madrid’s clock, newest first, with the service and the delivery, and nothing about the people', () => {
    const result = parseSzendex(shipment(), SHIPMENT);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Entregado',
      last_update: '2023-01-27T13:44:00+01:00', last_update_local: '2023-01-27T13:44:00', expected_delivery: null,
      delivered_at: '2023-01-27T13:44:00+01:00', service_name: 'ENTREGAS 24 HORAS',
      events: [
        { ...madrid('2023-01-27T13:44:00', '+01:00'), description: 'Entregado', stage: 'delivered', stage_source: 'carrier_map' },
        { ...madrid('2023-01-27T09:58:00', '+01:00'), description: 'En Reparto', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { ...madrid('2023-01-27T08:38:00', '+01:00'), description: 'En Agencia de destino', stage: 'in_transit', stage_source: 'carrier_map' },
        { ...madrid('2023-01-26T17:52:00', '+01:00'), description: 'Traza Salida', stage: 'in_transit', stage_source: 'carrier_map' },
        { ...madrid('2023-01-26T17:51:00', '+01:00'), description: 'Recogida', stage: 'accepted', stage_source: 'carrier_map' },
        { ...madrid('2023-01-26T17:35:00', '+01:00'), description: 'Asignada', stage: 'registered', stage_source: 'carrier_map' },
        // Two states of one minute keep the page's order, turned round.
        { ...madrid('2023-01-26T16:17:00', '+01:00'), description: 'Documentado', stage: 'registered', stage_source: 'carrier_map' },
        { ...madrid('2023-01-26T16:17:00', '+01:00'), description: 'Solicitada', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
    // The towns, the reference and the delivery note stay on the page.
    expect(JSON.stringify(result)).not.toMatch(/MANRESA|ALCAIDESA|W-5012|AlbDig|Imagenes/);
  });

  it('reads a summer clock at Madrid’s summer offset and a repeated hour at its first occurrence', () => {
    const summer = parseSzendex(shipment().replace('27/01/2023&nbsp;&nbsp;&nbsp;&nbsp;9:58', '15/07/2023&nbsp;&nbsp;&nbsp;&nbsp;9:58'), SHIPMENT);
    expect(summer.events!.find((event) => event.description === 'En Reparto')).toMatchObject(madrid('2023-07-15T09:58:00', '+02:00'));
    const repeated = parseSzendex(shipment().replace('27/01/2023&nbsp;&nbsp;&nbsp;&nbsp;9:58', '29/10/2023&nbsp;&nbsp;&nbsp;&nbsp;2:30'), SHIPMENT);
    expect(repeated.events!.find((event) => event.description === 'En Reparto')).toMatchObject(madrid('2023-10-29T02:30:00', '+02:00'));
  });

  it('reads a service order’s page, which ends at the pickup', () => {
    expect(parseSzendex(fixture(`order-${ORDER}`), ORDER)).toEqual({
      status: 'in_transit', current_stage: 'accepted', current_stage_source: 'carrier_map', last_status_text: 'Recogida',
      last_update: '2023-01-26T17:51:00+01:00', last_update_local: '2023-01-26T17:51:00', expected_delivery: null,
      service_name: 'ENTREGAS 24 HORAS',
      events: [
        { ...madrid('2023-01-26T17:51:00', '+01:00'), description: 'Recogida', stage: 'accepted', stage_source: 'carrier_map' },
        { ...madrid('2023-01-26T17:35:00', '+01:00'), description: 'Asignada', stage: 'registered', stage_source: 'carrier_map' },
        { ...madrid('2023-01-26T16:17:00', '+01:00'), description: 'Solicitada', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('reads the expected delivery day of a shipment on its way, and leaves a state no rule reads without a stage', () => {
    const html = shipment()
      .replace('<span id="lblEstadoDataRes">Entregado</span>', '<span id="lblEstadoDataRes">En Reparto</span>')
      .replace('<td id="lblFechaEntregaRes">Fecha de Entrega:</td><td><span id="lblFechaEntregaDataRes">27/01/2023&nbsp;&nbsp;&nbsp;&nbsp;13:44</span>',
        '<td id="lblFechaEntregaRes">Fecha prevista de Entrega:</td><td><span id="lblFechaEntregaDataRes">27/01/2023</span>')
      .replace(/<tr class="gridItemAlt">\s*<td>27\/01\/2023&nbsp;&nbsp;&nbsp;&nbsp;13:44<\/td><td>Entregado<\/td><td>&nbsp;<\/td>\s*<\/tr>/, '');
    const onTheWay = parseSzendex(html, SHIPMENT);
    expect(onTheWay).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'En Reparto',
      expected_delivery: '2023-01-27', last_update_local: '2023-01-27T09:58:00' });
    expect(onTheWay).not.toHaveProperty('delivered_at');
    const unread = parseSzendex(html.replace('<span id="lblEstadoDataRes">En Reparto</span>', '<span id="lblEstadoDataRes">Xyzzy</span>')
      .replaceAll('<td>En Reparto</td>', '<td>Xyzzy</td>'), SHIPMENT);
    // The newest staged scan stands when the summary's state is one no rule reads.
    expect(unread).toMatchObject({ current_stage: 'in_transit', last_status_text: 'Xyzzy' });
    expect(unread.events![0]).toMatchObject({ description: 'Xyzzy' });
    expect(unread.events![0]).not.toHaveProperty('stage');
  });

  it('reads the tracker’s notice for the number asked as not found, and no other', async () => {
    expect(() => parseSzendex(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    // The notice names no number: the page's form must post back to the one asked.
    expect(() => parseSzendex(fixture('not-found'), '999999999999999998')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSzendex(fixture('not-found').replace('action="./?seg=999999999999999999"', 'action="./"'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const notice of ['Debe introducir el "Núm. de Envío" para realizar la búsqueda.', 'Se ha producido un error.']) {
      expect(() => parseSzendex(fixture('not-found').replace('No se ha encontrado el envío solicitado.', notice), UNKNOWN), notice)
        .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('refuses a shipment the tracker found under another number, such as its sender’s reference, or a list of several', () => {
    expect(() => parseSzendex(shipment(), 'REF000123')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSzendex(shipment(), ORDER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const mixed = shipment().replace(`<span id="lblNumSeguimientoData">${SHIPMENT}</span>`, '<span id="lblNumSeguimientoData">009000298400000002</span>');
    expect(() => parseSzendex(mixed, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const list = fixture('not-found').replace('<div id="pnlError" class="errorContainer">', '<table id="gvSeleccionEnvio"></table><div>')
      .replace(/<span id="lblStackTrace">[^<]*<\/span>/, '');
    expect(() => parseSzendex(list, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a page without the number, a changed history, a scan without its state or a clock that is not one', () => {
    expect(() => parseSzendex(shipment().replace(`<span id="lblNumSeguimientoDataRes">${SHIPMENT}</span>`, ''), SHIPMENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSzendex(shipment().replace('<th scope="col">Estado</th>', '<th scope="col">Situación</th>'), SHIPMENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSzendex(shipment().replace('<td>Traza Salida</td>', '<td></td>'), SHIPMENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSzendex(shipment().replace('<td>Traza Salida</td><td>&nbsp;</td>', '<td>Traza Salida</td>'), SHIPMENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const clock of ['31/02/2023&nbsp;&nbsp;&nbsp;&nbsp;8:38', '27/13/2023&nbsp;&nbsp;&nbsp;&nbsp;8:38', '27/01/2023&nbsp;&nbsp;&nbsp;&nbsp;24:38',
      '27/01/2023&nbsp;&nbsp;&nbsp;&nbsp;8:61', '27/01/2023']) {
      expect(() => parseSzendex(shipment().replace('27/01/2023&nbsp;&nbsp;&nbsp;&nbsp;8:38', clock), SHIPMENT), clock)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseSzendex(shipment().replace('<div id="pnlTrazabilidad"', '<span id="lblStackTrace">Error</span><div id="pnlTrazabilidad"'), SHIPMENT))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseSzendex(CHALLENGE, SHIPMENT)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseSzendex('<html><body><h1>Mantenimiento</h1></body></html>', SHIPMENT)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a shipment without scans by its summary, and one without either as no history', () => {
    const bare = shipment().replace(/<table class="grid[\s\S]*?<\/table>/, '');
    expect(parseSzendex(bare, SHIPMENT)).toMatchObject({ status: 'delivered', last_status_text: 'Entregado', summary_only: true, events: [] });
    expect(() => parseSzendex(bare.replace('<span id="lblEstadoDataRes">Entregado</span>', '<span id="lblEstadoDataRes"></span>'), SHIPMENT))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [404, 'transport'], [410, 'transport'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(status === 403 ? CHALLENGE : '', status));
      await expect(carrier(fetcher).track({ number: UNKNOWN })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('keeps a challenge served with HTTP 200, redirects, empty pages and oversized replies apart from missing shipments', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(CHALLENGE))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'challenge' });
    const moved = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { Location: '/DlWebTrackingVWE/Error.aspx' } }));
    await expect(carrier(moved).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'transport' });
    for (const body of ['', '   ']) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'indeterminate' });
    }
    const large = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(600_000)));
    await expect(carrier(large).track({ number: SHIPMENT })).rejects.toThrow('unexpectedly large');
  });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(shipment()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    await expect(new SzendexTracker({ fetcher: flaky, recorder }).fetch(SHIPMENT, { budgetMs: 2000 })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ step: 'retry', outcome: 'ok' }));
    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(carrier(failing).track({ number: SHIPMENT }, { budgetMs: 2000 })).rejects.toBeInstanceOf(UpstreamNetworkError);
    expect(failing).toHaveBeenCalledTimes(2);
    const immediate = vi.fn<typeof fetch>().mockResolvedValue(reply(shipment()));
    await expect(carrier(immediate).track({ number: SHIPMENT }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    await expect(carrier(immediate).track({ number: SHIPMENT }, { budgetMs: 0 })).rejects.toMatchObject({ kind: 'budget' });
    expect(immediate).not.toHaveBeenCalled();
  });

  it('takes six to thirty letters and digits, with at least one digit, without a request for anything else', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['', '12345', 'ABCDEFGH', '0090/0029', `9${'0'.repeat(30)}`, '009000298400000001!']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(normalizeSzendexNumber('0090 0029 8400 0000 01')).toBe(SHIPMENT);
    expect(normalizeSzendexNumber(ORDER)).toBe(ORDER);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Szendex numbers and links', () => {
  it('routes a number to the adapter when the caller names Szendex or pastes its link, which detection never offers', async () => {
    expect(detectCarrierMatch(SHIPMENT).candidates).not.toContain('szendex');
    expect(recognitionAskedCarriers(SHIPMENT)).not.toContain('szendex');
    for (const link of [`https://erp.szendex.com/DlWebTrackingVWE/?seg=${SHIPMENT}`, `https://erp.szendex.com/DlWebTrackingVWE?seg=${SHIPMENT}`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: SHIPMENT, carrier: 'szendex', source: 'link' });
    }
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(shipment()));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: SHIPMENT, carrier: 'szendex' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'szendex', source: 'szendex', result: { current_stage: 'delivered' } });
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith(`${SZENDEX_TRACKER}?`))).toBe(true);
  });
});

describe('Szendex status vocabulary', () => {
  it('records every wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { wording: string; stage?: string }[]) {
      expect(szendexMappedStage(entry.wording), entry.wording).toBe(entry.stage);
      if (!entry.stage) continue;
      expect(szendexStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'szendex', description: entry.wording }), entry.wording).toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMap.stage('ENTREGADO', 'entregado')).toBeUndefined();
    expect(statusMapAnswer({ carrier: 'szendex', description: 'Ausente' })).toEqual({ kind: 'unknown' });
  });
});

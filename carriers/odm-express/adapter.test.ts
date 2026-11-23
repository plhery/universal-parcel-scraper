import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError, UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ODM_TRACKING, OdmTracker, odmTrackingUrl } from './adapter.js';
import { normalizeOdmGuide, odmWording, parseOdm } from './parser.js';
import { odmStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// The public sample, whose page the delivered fixture keeps.
const DELIVERED = numbers.records[0]!.number;
const PADDED = DELIVERED.replace(/^([A-Z])(\d+)$/, (_, letter: string, serial: string) => `${letter}${serial.padStart(9, '0')}`);
const UNKNOWN = 'P9999999';
const html = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = html('delivered');
const absent = html('not-found');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => {
  const $ = load(body);
  change($);
  return $.html();
};
const reply = (body = delivered, code = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status: code, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('ODM Express tracking adapter', () => {
  it('reads a delivered guide\'s rows, newest first, on the branches\' wall clocks', () => {
    const result = normalizeCarrierResult(parseOdm(delivered, DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO, ACUSE SCANNEADO', last_update: null, expected_delivery: null });
    expect(result.events!.map((event) => [event.local_time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2025-05-07T14:37:01', 'ENTREGADO, ACUSE SCANNEADO', null, 'delivered'],
      ['2025-05-07T14:37:01', 'CP ENTREGADA', null, 'delivered'],
      ['2025-05-03T09:34:47', 'EN RUTA DE REPARTO', null, 'out_for_delivery'],
      ['2025-05-03T09:17:50', 'RECIBIDA EN : CEDIS LEON, GTO, ORIGEN : CEDIS VALLEJO', 'CEDIS LEON, GTO', 'in_transit'],
      ['2025-05-02T23:03:59', 'TRASL. A : HILARIO MEDINA, GTO, unidad: 71 OMNICARGA', null, 'in_transit'],
      ['2025-05-02T09:16:42', 'RECIBIDA EN : CEDIS VALLEJO, ORIGEN : CEDIS CHIHUAHUA CHI', 'CEDIS VALLEJO', 'in_transit'],
      ['2025-04-30T07:33:44', 'TRASL. A : CEDIS VALLEJO, unidad: R1248 OMNICARGA', null, 'in_transit'],
      ['2025-04-29T12:33:15', 'TRASL. A : CHIHUAHUA, unidad: 1255 OMNIBUS', null, 'in_transit'],
      ['2025-04-29T11:48:01', 'C.P. DOCUMENTADA', null, 'accepted'],
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    // The people the rows name, the route references and the receipt stay out.
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE|RECIBIO|Guia|acuses|firma/i);
  });

  it('cuts the route references and the people out of an observation', () => {
    expect(odmWording('[Guia: 1307567] :  EN RUTA DE REPARTO, MENSAJERO : ANA PEREZ')).toBe('EN RUTA DE REPARTO');
    expect(odmWording('CP ENTREGADA, 07/05/2025 RECIBIO: ANA PEREZ')).toBe('CP ENTREGADA');
    expect(odmWording('C.P. DOCUMENTADA POR USUARIO :ALGUIEN')).toBe('C.P. DOCUMENTADA');
    expect(odmWording('RECIBIDA EN : CEDIS VALLEJO, [Guia Paq.: 18427] ORIGEN : CEDIS CHIHUAHUA CHI'))
      .toBe('RECIBIDA EN : CEDIS VALLEJO, ORIGEN : CEDIS CHIHUAHUA CHI');
  });

  it('asks the page for the guide as typed, padded or not', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    await expect(carrier(fetcher).track({ number: ` ${DELIVERED.toLowerCase()} ` })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${ODM_TRACKING}?rastreo_fall=${DELIVERED}`]);
    expect(odmTrackingUrl(PADDED)).toBe(`https://odmexpress.com.mx/rastreo-2/?rastreo_fall=${PADDED}`);
    const padded = delivered.replaceAll(`<td>${DELIVERED}</td>`, `<td>${PADDED}</td>`);
    expect(parseOdm(padded, PADDED)).toMatchObject({ status: 'delivered' });
  });

  it('keeps an observation neither map knows without a stage', () => {
    const unknown = edit(($) => { $('tr.rastreorow').slice(1).remove(); $('tr.rastreorow').children('td').eq(3).text('CAMBIO DE PLAZA'); });
    const result = parseOdm(unknown, DELIVERED);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'CAMBIO DE PLAZA', last_update_local: '2025-04-29T11:48:01' });
    expect(result).not.toHaveProperty('current_stage');
    expect(result.events![0]).not.toHaveProperty('stage');
  });

  it('answers not found only when the notice names the guide asked', async () => {
    expect(() => parseOdm(absent, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseOdm(absent, 'P9999998')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(vi.fn<typeof fetch>(async () => reply(absent))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('reads the notice from its cell, however much of the page the open table takes in ahead of it', () => {
    const footer = `<p>${'Atención a clientes de lunes a viernes. '.repeat(40)}</p>`;
    const page = absent.replace('</body>', `${footer}</body>`);
    expect(load(page)('#resultados_rastreo').text().indexOf('no existe')).toBeGreaterThan(1000);
    expect(() => parseOdm(page, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('rejects rows for another guide as inconclusive', () => {
    const other = edit(($) => { $('tr.rastreorow').eq(3).children('td').first().text('P325591'); });
    expect(() => parseOdm(other, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('fails on a page without its table, or a row without its day and clock, instead of guessing', () => {
    expect(() => parseOdm('<html><body><p>Mantenimiento</p></body></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const noRows = edit(($) => { $('tr.rastreorow').remove(); });
    expect(() => parseOdm(noRows, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const badDay = edit(($) => { $('tr.rastreorow').first().children('td').eq(1).text('2025-02-30 00:00:00'); });
    expect(() => parseOdm(badDay, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    const badClock = edit(($) => { $('tr.rastreorow').first().children('td').eq(2).text('25:00:00'); });
    expect(() => parseOdm(badClock, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a browser check or a refusal apart from a missing guide', async () => {
    const check = '<html><head><title>Just a moment...</title></head><body>_cf_chl_opt</body></html>';
    expect(() => parseOdm(check, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(carrier(vi.fn<typeof fetch>(async () => reply(check, 403, { 'cf-mitigated': 'challenge' }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(new OdmTracker({ fetcher: vi.fn<typeof fetch>(async () => reply('denied', 403)) }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(new OdmTracker({ fetcher: vi.fn<typeof fetch>(async () => reply('', 301, { Location: '/' })) }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new UpstreamNetworkError('ODM Express', 'socket hang up'))
      .mockResolvedValueOnce(reply());
    await expect(new OdmTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects anything but a letter and five to nine digits without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const typed of ['325590', 'PP325590', 'P1234', 'P1234567890', `${DELIVERED},P1234567`, '']) {
      expect(() => normalizeOdmGuide(typed)).toThrow(InvalidInputError);
      await expect(carrier(fetcher).track({ number: typed })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage', () => {
    for (const entry of statuses.entries) {
      expect(odmStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'odm-express', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'odm-express', providerCode: 'X', description: 'CP ENTREGADA' })).toEqual({ kind: 'unknown' });
    expect(odmStage('CAMBIO DE PLAZA')).toBeNull();
  });
});

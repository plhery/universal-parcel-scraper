import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { languageStageStatus, STAGES } from '../../core/status/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { FlechaAmarillaTracker } from './adapter.js';
import { normalizeFlechaNumber, parseFlecha, parseFlechaReply } from './parser.js';
import { flechaStage, statusMap } from './status.js';

// Public samples: archived lookups on the carrier's former tracker (numbers.json), and the tracker's replies for them.
const fixture = (name: 'C1503571' | 'P286186') => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const changed = (edit: (guia: ReturnType<typeof fixture>['respuesta'][0]) => void) => { const data = fixture('C1503571'); edit(data.respuesta[0]); return data; };
const response = (data: unknown, status = 200) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
const EMPTY = { codigoEstado: 200, codigoMensaje: "COM-20001'0", idioma: 'ESPAÑOL', mensajeTecnico: 'OK', mensajeUsuario: 'OK', respuesta: [] };
const statuses = JSON.parse(readFileSync(new URL('./statuses.json', import.meta.url), 'utf8')) as { entries: { wording: string; stage: string }[] };

describe('Paquetería Flecha Amarilla guest adapter', () => {
  it('asks for the prefix and the digits apart, with the page\'s key and the supplied transport and budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(fixture('C1503571')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new FlechaAmarillaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(' c 1503571 ', { budgetMs: 4000 });
    expect(result.events).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://c1trtsss68.execute-api.us-east-1.amazonaws.com/prod/guias/rastreoGuias');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1' } });
    expect(JSON.parse(String(init!.body))).toEqual([{ indice: '0', prefijo: 'C', numeroGuia: '1503571' }]);
    expect(new Headers(init!.headers).get('Authorization')).toMatch(/^U2FsdGVkX1[\w+/=]{40,}$/);
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'flecha-amarilla', step: 'direct', outcome: 'ok' }));
  });

  it('reads a guía in every written form and refuses other shapes', () => {
    for (const written of ['C1503571', 'c 1503571', 'C-1503571', ' C - 1503571 ']) expect(normalizeFlechaNumber(written)).toEqual({ prefix: 'C', number: '1503571' });
    expect(normalizeFlechaNumber('CB699509')).toEqual({ prefix: 'CB', number: '699509' });
    expect(normalizeFlechaNumber('PB 123456')).toEqual({ prefix: 'PB', number: '123456' });
    for (const wrong of ['', 'X1503571', 'C', 'C12', 'C1503571A', '1503571', 'CB-']) expect(() => normalizeFlechaNumber(wrong)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('reads the scans newest first with the branch and the offset each clock states', () => {
    const result = parseFlecha(fixture('C1503571'), 'C1503571');
    expect(result).toMatchObject({ status: languageStageStatus('delivered'), current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADA', last_update: '2017-03-07T12:56:14-06:00', expected_delivery: null,
      delivered_at: '2017-03-07T12:56:14-06:00', signed_by: 'FELIPE POMPOSO' });
    expect(result.events!.map(event => [event.time, event.description, event.location, event.stage])).toEqual([
      ['2017-03-07T12:56:14-06:00', 'ENTREGADA', 'MONTERREY 01', 'delivered'],
      ['2017-03-06T16:58:07-06:00', 'DESEMBARCADA', 'MONTERREY', 'in_transit'],
      ['2017-03-06T16:58:07-06:00', 'EN OCURRE', 'MONTERREY', 'ready_for_pickup'],
      ['2017-03-04T15:16:33-06:00', 'EN TRÁFICO', 'MEXICO', 'in_transit'],
      ['2017-03-03T14:09:22-06:00', 'EMBARCADA', 'MEXICO', 'in_transit'],
      ['2017-03-02T22:22:05-06:00', 'DESEMBARCADA', 'MEXICO', 'in_transit'],
      ['2017-03-02T22:22:05-06:00', 'TRASBORDO', 'MEXICO', 'in_transit'],
      ['2017-03-02T18:54:04-06:00', 'EN TRÁFICO', 'PUEBLA', 'in_transit'],
      ['2017-03-02T18:48:46-06:00', 'EMBARCADA', 'PUEBLA', 'in_transit'],
      ['2017-03-02T18:09:42-06:00', 'DOCUMENTADA', 'PUEBLA', 'accepted'],
    ]);
    // The names of the sender and the addressee, the branches of origin and destination and the delivery note stay out.
    const text = JSON.stringify(result);
    for (const left of ['ANDREA', 'BIO LIFE', 'Entregado a']) expect(text).not.toContain(left);
    expect(parseFlecha(fixture('P286186'), 'P 286186')).toMatchObject({ current_stage: 'delivered', signed_by: 'MARTINEZ CORTES WILLIAMS',
      delivered_at: '2016-07-22T11:06:15-06:00', events: expect.arrayContaining([expect.objectContaining({ location: 'CENTRAL MEX' })]) });
  });

  it('keeps a scan\'s clock only when its wall clock and its instant agree', () => {
    expect(() => parseFlecha(changed(guia => { guia.eventos[0].fechaTexto = '2017-03-02 19:09:42'; }), 'C1503571')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlecha(changed(guia => { guia.eventos[0].fecha = '1488499782000'; }), 'C1503571')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const shifted = parseFlecha(changed(guia => { guia.eventos[0].fecha = '/Date(1488495782000-0500)/'; guia.eventos[0].fechaTexto = '2017-03-02 18:03:02'; }), 'C1503571');
    expect(shifted.events!.at(-1)!.time).toBe('2017-03-02T18:03:02-05:00');
  });

  it('lets a newer state undo a delivery and keeps an unnamed state without a stage', () => {
    const after = parseFlecha(changed(guia => { guia.eventos.push({ ...guia.eventos[9], estadoActual: 'SINIESTRADA', fecha: '/Date(1488999374000-0600)/', fechaTexto: '2017-03-08 12:56:14', receptor: '' }); }), 'C1503571');
    expect(after).toMatchObject({ status: 'unknown', last_status_text: 'SINIESTRADA' });
    expect(after.current_stage).toBeUndefined();
    expect(after.delivered_at).toBeUndefined();
    expect(after.events![0]!.stage).toBeUndefined();
  });

  it('reads an empty list as inconclusive, since the tracker answers so for a guía it knows when asked too often', async () => {
    await expect(new FlechaAmarillaTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response(EMPTY)) }).fetch('P9999999'))
      .rejects.toMatchObject({ kind: 'indeterminate', reason: 'portal_not_found' });
  });

  it('requires the reply to name the whole guía', () => {
    expect(() => parseFlecha(fixture('C1503571'), 'C1503570')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlecha(fixture('C1503571'), 'CB1503571')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const two = fixture('C1503571'); two.respuesta.push(fixture('P286186').respuesta[0]);
    expect(() => parseFlecha(two, 'C1503571')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlecha(changed(guia => { guia.eventos = []; }), 'C1503571')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps failures apart from a missing guía', async () => {
    expect(() => parseFlecha({ ...EMPTY, codigoEstado: 500 }, 'C1503571')).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => parseFlecha({ ...EMPTY, respuesta: null }, 'C1503571')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseFlechaReply('<html><title>Just a moment...</title></html>', 'C1503571')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseFlechaReply('<html>gateway</html>', 'C1503571')).toThrow(expect.objectContaining({ kind: 'schema' }));
    // The service answers HTTP 502 when the request lacks its key or it fails.
    const failed = new FlechaAmarillaTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response({ message: 'Internal server error' }, 502)) });
    await expect(failed.fetch('C1503571')).rejects.not.toMatchObject({ kind: 'not_found' });
  });

  it('declares each state it stages', () => {
    for (const entry of statuses.entries) {
      expect(STAGES).toContain(entry.stage);
      expect(flechaStage(entry.wording)).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording.toLowerCase())).toBe(entry.stage);
    }
  });
});

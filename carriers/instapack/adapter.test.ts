import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, INSTAPACK_TRACKING, InstapackTracker } from './adapter.js';
import { instapackResultPath, normalizeInstapackNumber, parseInstapack, parseInstapackRefusal } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples in numbers.json, and an invented code the tracker does not know.
const SAMPLE = 'CNES00102358787';
const ORDER_ID = '090420181030503';
const OTHER = 'CNES90000000017';
// A token in the shape of the signed page's: its payload names a code and its week.
const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU5USEVUSUMiLCJpYXQiOjE4OTM0NTYwMDAsImV4cCI6MTg5NDA2MDgwMH0.SyntheticSignature0000000000000000000000000';
const RESULT = `/client-dashboard/seguimiento-de-envios/${TOKEN}`;

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const redirect = (location = RESULT) => html('', { status: 302, headers: { Location: location } });
/** The form's answer, then the parcel's page. */
const flow = (answer: () => Response, page: () => Response = () => html(DELIVERED)) =>
  vi.fn<typeof fetch>().mockImplementation(async (_url, init) => (init?.method === 'POST' ? answer() : page()));
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const CHALLENGE = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// A synthetic parcel's page in the tracker's shape, with a driver, an incident and the given rows.
const page = (code: string, rows: string[], delivered?: string) => `
<article class="panel panel-info"><div class="panel-heading"><h2 class="panel-title">
  <strong>Nº de seguimiento: </strong>${code}<strong>Fecha: </strong>12/01/2030</h2></div>
  <div class="panel-body"><div class="col-12 pr-0"><strong>Entrega: </strong> Calle Sintética 1, 28000 Madrid <br/>
  <strong>Cantidad de paquetes: </strong>1<br/><strong>Refenrencia : </strong>SYNTHETICREF1<br/></div></div></article>
<article class="panel panel-info"><div class="panel-heading"><h2 class="panel-title">
  <strong>¡Ya tienes repartidor asignado! </strong> - Synthetic Driver <strong><i class="fa fa-phone"></i></strong> 600 11 22 33</h2></div>
  <div class="panel-body"><div class="col-9 pr-0">${rows.join('<br/>')}<br/></div></div></article>
${delivered ? `<article class="panel panel-info"><div class="panel-heading"><h2 class="panel-title">
  <span>${delivered} </span><strong>¡Hemos realizado la entrega!</strong></h2></div>
  <div class="panel-body"><div class="col-9 pr-0">Calle Sintética 1, 28000 Madrid</div></div></article>` : ''}`;

describe('Instapack codes', () => {
  it('takes 6 to 40 letters and digits with at least one digit, in capitals', () => {
    expect(normalizeInstapackNumber(` ${SAMPLE.toLowerCase().slice(0, 4)} ${SAMPLE.slice(4)} `)).toBe(SAMPLE);
    expect(normalizeInstapackNumber(ORDER_ID)).toBe(ORDER_ID);
    for (const other of ['', '12345', 'INSTAPACK', `${SAMPLE},${OTHER}`, 'CNES/0010', `${'A'.repeat(40)}1`, '1'.repeat(65)]) {
      expect(() => normalizeInstapackNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('follows a redirect only to a parcel’s signed page on the tracker', () => {
    expect(instapackResultPath(RESULT)).toBe(RESULT);
    expect(instapackResultPath(`https://back.instapack.es${RESULT}`)).toBe(RESULT);
    for (const other of [null, '', '/client-dashboard/loginonly/', `https://example.com${RESULT}`, `${RESULT}/../../admin`,
      '/client-dashboard/seguimiento-de-envios/', `//evil.example${RESULT}`]) {
      expect(instapackResultPath(other), String(other)).toBeUndefined();
    }
  });
});

describe('Instapack tracking adapter', () => {
  it('posts the code as the form, then reads the parcel’s page it redirects to, through the supplied transport', async () => {
    const fetcher = flow(() => redirect());
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new InstapackTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(SAMPLE.toLowerCase(), { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[formUrl, formInit], [pageUrl, pageInit]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect([String(formUrl), String(pageUrl)]).toEqual([INSTAPACK_TRACKING, `https://back.instapack.es${RESULT}`]);
    expect(formInit).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(String(formInit.body)).toBe(`code=${SAMPLE}`);
    expect(pageInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'instapack', step: 'direct', outcome: 'ok' }));
    expect(carrier(fetcher)).toMatchObject({ id: 'instapack', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the form’s message for an unknown code as not found', async () => {
    await expect(carrier(flow(() => html(NOT_FOUND))).track({ number: OTHER })).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseInstapackRefusal(NOT_FOUND)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('keeps challenges, refusals, redirects and changed pages apart from a missing parcel', async () => {
    const answer = async (form: () => Response, result?: () => Response) => carrier(flow(form, result))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html(CHALLENGE, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(CHALLENGE, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(CHALLENGE))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => redirect(), () => html(CHALLENGE))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => redirect(), () => html('', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('', { status: 404 }))).toMatchObject({ kind: 'transport' });
    // Another message on the form leaves the answer open; the form without one, or another page, is a changed reply.
    expect(await answer(() => html(NOT_FOUND.replace('No se localiza ningún paquete', 'Error del sistema')))).toMatchObject({ kind: 'indeterminate' });
    expect(await answer(() => html(NOT_FOUND.replace('No se localiza ningún paquete', '')))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<!doctype html><html><body>Instapack</body></html>'))).toMatchObject({ kind: 'schema' });
    // A redirect anywhere but a parcel's page, or a page that redirects again, is not a parcel.
    expect(await answer(() => redirect('/client-dashboard/loginonly/'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('', { status: 302 }))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => redirect(), () => redirect(INSTAPACK_TRACKING))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => redirect(), () => html('<!doctype html><html><body>Instapack</body></html>'))).toMatchObject({ kind: 'schema' });
    // The page for another code.
    expect(await answer(() => redirect())).toMatchObject({ kind: 'schema' });
  });
});

describe('Instapack pages', () => {
  it('reads the delivered sample: the driver’s steps, the incidents and the delivery on their wall clocks', () => {
    const result = parseInstapack(DELIVERED, SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: '¡Hemos realizado la entrega!',
      last_update: null, last_update_local: '2022-03-29T17:49:00', expected_delivery: null,
    });
    expect(result.events).toEqual([
      { local_time: '2022-03-29T17:49:00', description: '¡Hemos realizado la entrega!', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2022-03-28T16:29:00', description: 'Incidencias en entrega - Ausente', stage: 'failed_attempt', stage_source: 'carrier_map' },
      { local_time: '2022-03-25T10:58:00', description: 'Incidencias en entrega - Ausente', stage: 'failed_attempt', stage_source: 'carrier_map' },
      { local_time: '2022-03-25T08:56:00', description: 'Salida a reparto', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2022-03-25T08:56:00', description: 'Conductor asignado', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-03-25T07:58:00', description: 'Salida a reparto', stage: 'out_for_delivery', stage_source: 'carrier_map' },
      { local_time: '2022-03-25T07:58:00', description: 'Conductor asignado', stage: 'in_transit', stage_source: 'carrier_map' },
    ]);
  });

  it('reads the order id sample, whose driver’s steps come oldest first', () => {
    expect(parseInstapack(fixture('delivered-order-id'), ORDER_ID).events?.map((event) => [event.local_time, event.description])).toEqual([
      ['2018-04-09T20:41:00', '¡Hemos realizado la entrega!'],
      ['2018-04-09T19:33:00', 'Salida a reparto'],
      ['2018-04-09T19:31:00', 'Conductor asignado'],
    ]);
  });

  it('never reads the address, the driver, their phone or the sender’s references', () => {
    const answer = JSON.stringify(parseInstapack(page(SAMPLE, ['12/01/30 09:00 - Conductor asignado', '12/01/30 09:01 - Salida a reparto'], '12/01/2030 11:00'), SAMPLE));
    for (const hidden of ['Sintética', '28000', 'Synthetic', '600', 'SYNTHETICREF']) expect(answer).not.toContain(hidden);
    for (const hidden of ['EJEMPLO', 'Nombre', '600 00']) expect(JSON.stringify(parseInstapack(DELIVERED, SAMPLE))).not.toContain(hidden);
    // A row never passes on a phone number or an email address.
    expect(parseInstapack(page(SAMPLE, ['12/01/30 09:00 - Incidencias en entrega - Llamar al 600 11 22 33 o a nadie@example.com']), SAMPLE).events?.[0])
      .toMatchObject({ local_time: '2030-01-12T09:00:00', description: 'Incidencias en entrega - Llamar al o a' });
  });

  it('stands a parcel on its newest step, and keeps a wording the map does not know visible', () => {
    expect(parseInstapack(page(SAMPLE, ['12/01/30 09:00 - Conductor asignado', '12/01/30 09:00 - Salida a reparto']), SAMPLE))
      .toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'Salida a reparto', last_update_local: '2030-01-12T09:00:00' });
    const unknown = parseInstapack(page(SAMPLE, ['12/01/30 09:00 - Conductor asignado', '12/01/30 10:00 - Paquete aparcado']), SAMPLE);
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Paquete aparcado' });
    expect(unknown.events?.[0]).toEqual({ local_time: '2030-01-12T10:00:00', description: 'Paquete aparcado' });
    expect(() => parseInstapack(page(SAMPLE, []), SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('reads a code in other case and spacing as the page’s, and refuses a page for another code', () => {
    expect(parseInstapack(DELIVERED, ` ${SAMPLE.toLowerCase()} `)).toMatchObject({ current_stage: 'delivered' });
    expect(() => parseInstapack(DELIVERED, OTHER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInstapack(fixture('delivered-order-id'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('refuses a challenge or a changed page', () => {
    expect(() => parseInstapack(CHALLENGE, SAMPLE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    for (const changed of ['', '<html><body>Instapack</body></html>', NOT_FOUND, page(SAMPLE, ['32/01/30 09:00 - Conductor asignado']),
      page(SAMPLE, ['12/13/30 09:00 - Conductor asignado']), page(SAMPLE, ['12/01/30 09:00 - Conductor asignado'], '30/02/2030 11:00'),
      page(SAMPLE, Array.from({ length: 201 }, () => '12/01/30 09:00 - Conductor asignado'))]) {
      expect(() => parseInstapack(changed, SAMPLE), changed.slice(0, 80)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

describe('Instapack statuses', () => {
  it('maps every wording whole', () => {
    for (const entry of statuses.entries) {
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'instapack', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
    }
    expect(statusMap.stage('X', 'salida a reparto')).toBeUndefined();
    expect(statusMap.stage(null, 'anything')).toBeUndefined();
  });
});

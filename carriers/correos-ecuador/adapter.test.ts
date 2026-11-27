import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_MAPS } from '../../core/catalog/statusMaps.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CORREOS_ECUADOR_TRACKING, CorreosEcuadorTracker } from './adapter.js';
import { correosEcuadorFormFields, normalizeCorreosEcuadorNumber, parseCorreosEcuador } from './parser.js';
import { correosEcuadorStage, correosEcuadorStatusStage, withoutReceiver } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample: a USPS parcel that cleared customs in Quito and was delivered.
const ITEM = 'CH166241282US';
// A synthetic code with a valid check digit, which the tracker does not know.
const UNKNOWN = 'RR900000005EC';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The form, then the answer to the posted code.
const exchange = (answer: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(answer);
// One scan of the history, as the page writes it.
const scan = (day: string, clock: string, wording: string, place: string) => '<div class="tracking-item"><div class="tracking-icon"><i class="fas fa-truck"></i></div>'
  + `<div class="tracking-date">${day}<span>${clock}</span></div><div class="tracking-content">${wording}<span> ${place}</span></div><div></div></div>`;
// The sample's page with these scans in its history.
const withScans = (scans: string[]) => page('delivered').replace(/<ul>[\s\S]*<\/ul>/, `<ul>${scans.join('')}</ul>`);
// The form sent back with the message the page shows in a startup script.
const withMessage = (text: string) => page('form').replace('</form>', `<script type="text/javascript">mensaje('warning', 'Advertencia', '${text}', null);</script></form>`);
// The map the catalog registers for the carrier, asked as the app asks it.
const registered = (wording: string) => STATUS_MAPS['correos-ecuador']!.stage(null, normalizeStatusWording(wording));
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
const OOPS = '<!DOCTYPE html><html><head><title>\n\tOops\n</title></head><body><form method="post" id="ctl01"></form></body></html>';

describe('Servicios Postales del Ecuador tracking adapter', () => {
  it('opens the form and posts the whole code back with its state through the supplied transport', async () => {
    const fetcher = exchange(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CorreosEcuadorTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ch 166 241 282 us ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [[formUrl, formInit], [url, init]] = fetcher.mock.calls as [[string, RequestInit], [string, RequestInit]];
    expect(formUrl).toBe(CORREOS_ECUADOR_TRACKING);
    expect(formInit).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(url).toBe(CORREOS_ECUADOR_TRACKING);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Referer: CORREOS_ECUADOR_TRACKING, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      __EVENTTARGET: 'ctl00$MainContent$btn_buscar', __EVENTARGUMENT: '', __VIEWSTATE: 'SYNTHETIC-VIEWSTATE', __VIEWSTATEGENERATOR: 'AF2B511F',
      __EVENTVALIDATION: 'SYNTHETIC-EVENTVALIDATION', 'ctl00$MainContent$hdfControl': '', 'ctl00$MainContent$hf_codigoEnvio': '',
      'ctl00$MainContent$hf_etiqueta': '', 'ctl00$MainContent$txt_codigo_envio': ITEM, 'g-recaptcha-response': '',
    });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'correos-ecuador', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s history as wall clocks, without who took the parcel', () => {
    const result = parseCorreosEcuador(page('delivered'), ITEM);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Entregado al cliente', last_update: null, last_update_local: '2022-09-01T16:19:00', expected_delivery: null,
      destination_country: 'EC' });
    expect(result.events).toEqual([
      { local_time: '2022-09-01T16:19:00', location: 'Ag. CCNU', description: 'Entregado al cliente', stage: 'delivered', stage_source: 'carrier_map' },
      { local_time: '2022-08-31T10:00:00', location: 'Ag. CCNU', description: 'Recibido en oficina de Distribución', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-08-26T17:03:00', location: 'Centro Clasificación Quito', description: 'Despachado a oficina Ag. CCNU', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-08-26T14:08:00', location: 'Centro Clasificación Quito', description: 'Recibido en oficina', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-08-22T10:48:00', location: 'Centro Clasificación Quito', description: 'Despachado a oficina', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-08-17T08:59:00', location: 'Centro Clasificación Quito', description: 'Recibido en oficina', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-08-16T14:14:00', location: 'Área revisión aduana- Quito', description: 'Despachado a oficina Centro Clasificación Quito', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-08-16T11:45:00', location: 'Oficina Internacional QUITO', description: 'Salida de aduana - importación', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-08-15T14:19:00', location: 'Oficina Internacional QUITO', description: 'Proceso de revisión aduana - importación - Otro', stage: 'customs', stage_source: 'carrier_map' },
      { local_time: '2022-08-09T11:22:00', location: 'Oficina Internacional QUITO', description: 'Recibido Ecuador- inicio procesamiento', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-07-15T07:30:00', location: 'United States of America', description: 'Paquete enviado a país destino', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-07-14T13:41:00', location: 'United States of America', description: 'Despachado a destino', stage: 'in_transit', stage_source: 'carrier_map' },
      { local_time: '2022-07-11T16:17:00', location: 'United States of America', description: 'Envío recibido del cliente', stage: 'accepted', stage_source: 'carrier_map' },
    ]);
    expect(result.events!.every((event) => event.time === undefined)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/NOMBRE|APELLIDO|0000000000|Recibido por|Sí Postal|pagado/);
  });

  it('drops a receiver and any identity number from a wording, and reads every month the page abbreviates', () => {
    expect(withoutReceiver('Entregado al cliente - Recibido por: NOMBRE APELLIDO 0000000000')).toBe('Entregado al cliente');
    expect(withoutReceiver('Entregado al cliente  - recibida por NOMBRE')).toBe('Entregado al cliente');
    expect(withoutReceiver('Notificado 0999999999 al cliente')).toBe('Notificado al cliente');
    expect(withoutReceiver('Recibido en oficina')).toBe('Recibido en oficina');
    const months = ['Ene.', 'Feb.', 'Mar.', 'Abr.', 'May.', 'Jun.', 'Jul.', 'Ago.', 'Sep.', 'Oct.', 'Nov.', 'Dic.'];
    const result = parseCorreosEcuador(withScans(months.map((month) => scan(`${month} 2, 2024`, '9:05', 'Recibido en oficina', 'Ag. Synthetic'))), ITEM);
    expect(result.events!.map((event) => event.local_time)).toEqual(months.map((_, index) => `2024-${String(index + 1).padStart(2, '0')}-02T09:05:00`));
    expect(parseCorreosEcuador(withScans([scan('May 2, 2024', '23:59', 'Recibido en oficina', 'Ag. Synthetic')]), ITEM).events![0]!.local_time)
      .toBe('2024-05-02T23:59:00');
    // The page also writes the day first, between slashes.
    const dayFirst = parseCorreosEcuador(withScans([
      scan('03/Sep/2024', '10:00', 'Estado sintético', 'Ag. Synthetic'),
      scan('2/Ago./2024', '9:05', 'Recibido en oficina', 'Ag. Synthetic'),
    ]), ITEM);
    expect(dayFirst.events!.map((event) => event.local_time)).toEqual(['2024-09-03T10:00:00', '2024-08-02T09:05:00']);
  });

  it('keeps wording it cannot stage visible, and the stage of the scans before it', () => {
    const result = parseCorreosEcuador(withScans([
      scan('Sep. 3, 2022', '10:00', 'Estado sintético', 'Ag. Synthetic'),
      scan('Sep. 2, 2022', '9:00', 'Recibido en oficina', 'Ag. Synthetic'),
    ]), ITEM);
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Estado sintético' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).not.toHaveProperty('destination_country');
  });

  it('reads the card for a code the tracker does not know as not found', async () => {
    expect(() => parseCorreosEcuador(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(exchange(reply(page('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('binds the answer to the whole code and refuses a changed page', () => {
    // A card or a history for another code is no answer for this one.
    expect(() => parseCorreosEcuador(page('not-found'), 'RR900000019EC')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCorreosEcuador(page('delivered').replace('Historial de eventos: CH166241282US', 'Historial de eventos: CH166241296US'), ITEM))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCorreosEcuador(page('delivered').replace('Historial de eventos: ', 'Eventos: '), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A found card without its history, or a not-found card beside one, is no answer either.
    expect(() => parseCorreosEcuador(page('delivered').replace('MainContent_divHistorialEventos', 'MainContent_divOtro'), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosEcuador(page('not-found').replace('no localizado', 'pendiente'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosEcuador(page('delivered').replace('MainContent_rpt_envios_divDetalle_0', 'MainContent_rpt_envios_divDetalleNoExiste_0'), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosEcuador(withScans([]), ITEM)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    for (const [day, clock] of [['Ago. 32, 2022', '10:00'], ['Aug. 1, 2022', '10:00'], ['Ago. 1, 2022', '24:00'], ['2022-08-01', '10:00'],
      ['32/Ago/2022', '10:00'], ['01/Aug/2022', '10:00'], ['08/01/2022', '10:00'], ['01/Ago/2022, 2022', '10:00']]) {
      expect(() => parseCorreosEcuador(withScans([scan(day!, clock!, 'Recibido en oficina', 'Ag. Synthetic')]), ITEM), day)
        .toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    expect(() => parseCorreosEcuador(withScans([scan('Ago. 1, 2022', '10:00', '', 'Ag. Synthetic')]), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosEcuador('<html><title>Seguimiento</title></html>', ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the form sent back without an answer as a search without the code or a reCAPTCHA demand, never as not found', () => {
    expect(() => parseCorreosEcuador(withMessage('Ingrese al menos un código de rastreo'), ITEM)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseCorreosEcuador(withMessage('Valide el captcha'), ITEM)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCorreosEcuador(page('form'), ITEM)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCorreosEcuador(page('form').replace(/g-recaptcha/g, 'widget'), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosEcuador(BLOCKED, ITEM)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCorreosEcuador(OOPS, ITEM)).toThrow(expect.objectContaining({ kind: 'transport' }));
  });

  it('needs the form\'s state before posting', () => {
    expect(() => correosEcuadorFormFields(page('form').replace('SYNTHETIC-VIEWSTATE', ''), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => correosEcuadorFormFields(page('form').replace('ctl00$MainContent$txt_codigo_envio', 'other'), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => correosEcuadorFormFields(OOPS, ITEM)).toThrow(expect.objectContaining({ kind: 'transport' }));
    expect(() => correosEcuadorFormFields(BLOCKED, ITEM)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => correosEcuadorFormFields('<html><form id="ctl01"></form></html>', ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps refusals, block pages, moved routes and rate limits apart from a missing item, and retries a network failure once', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValueOnce(reply(BLOCKED))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(exchange(reply(BLOCKED))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(exchange(reply('Forbidden', 403))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(exchange(reply(BLOCKED, 503))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(exchange(reply('', 503))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(exchange(reply('', 302, { Location: '/Error' }))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValueOnce(reply('', 404))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(exchange(reply('', 429))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(exchange(reply(OOPS))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'transport' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(page('form'))).mockResolvedValueOnce(reply(page('delivered')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('takes S10 codes with a valid check digit and refuses anything else before a request', async () => {
    expect(normalizeCorreosEcuadorNumber('ch166241282us')).toBe(ITEM);
    for (const bad of ['CH166241283US', 'CH16624128US', '166241282', 'X'.repeat(65)]) {
      expect(() => normalizeCorreosEcuadorNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'CH166241283US' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage, with or without its receiver or office', () => {
    for (const entry of statuses.entries) {
      expect(correosEcuadorStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(registered(entry.wording), entry.wording).toBe(entry.stage);
    }
    for (const [wording, stage] of [
      ['Entregado al cliente - Recibido por: NOMBRE APELLIDO 0000000000', 'delivered'],
      ['Despachado a oficina Ag. Synthetic', 'in_transit'],
      ['Despachado a oficina', 'in_transit'],
      ['Proceso de revisión aduana - importación - Documentos', 'customs'],
    ] as const) {
      expect(registered(wording), wording).toBe(stage);
    }
    expect(correosEcuadorStatusStage('Despachado a oficinas')).toBeUndefined();
  });
});

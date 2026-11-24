import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, INPOSDOM_FORM, INPOSDOM_SEARCH, InposdomTracker } from './adapter.js';
import { normalizeInposdomNumber, parseInposdom } from './parser.js';
import { inposdomStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample: a Singapore Post parcel processed at the head office for the Puerto Plata office.
const ITEM = 'LF065150446SG';
// A synthetic code with a valid check digit, which the tracker does not know.
const UNKNOWN = 'LX271828189SG';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const once = (result: Response) => vi.fn<typeof fetch>().mockResolvedValueOnce(result);
// One record of the result table, as the page writes it.
const row = (code: string, entered = '2025-07-01', status = 'PROCESANDO EN LA SEDE CENTRAL') =>
  `<tr><td>BULTO POSTAL</td><td>${code}</td><td>0.25</td><td>PUERTO PLATA</td><td>RECIPIENT NAME</td><td>Ninguno</td>`
  + `<td>${entered}</td><td>${status}</td><td>Av. 12 de Julio esq. Separacion, Puerto Plata</td></tr>`;
// The sample's page with these records and the count the notice gives.
const withRows = (rows: string[], count = rows.length) => page('processing')
  .replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>\n${rows.join('')}</tbody>`)
  .replace('HEMOS ENCONTRADO 1 REGISTRO(S)', `HEMOS ENCONTRADO ${count} REGISTRO(S)`);
const BLOCKED = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
// The form page without an answer, as a GET returns it.
const FORM = page('not-found').replace(/<div class='alert[\s\S]*?<\/div>/, '');

describe('INPOSDOM tracking adapter', () => {
  it('posts the whole code to the tracker\'s form through the supplied transport', async () => {
    const fetcher = once(reply(page('processing')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new InposdomTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' lf 065 150 446 sg ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(INPOSDOM_SEARCH);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Referer: INPOSDOM_FORM, 'User-Agent': 'SyntheticHost/1.0' } });
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ buscar: ITEM, buscador: 'BUSCAR' });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'inposdom', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads the sample\'s status and its entry day, without the addressee, the weight or a clock', () => {
    const result = parseInposdom(page('processing'), ITEM);
    expect(result).toEqual({ status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'PROCESANDO EN LA SEDE CENTRAL', last_update: null, expected_delivery: null,
      service_name: 'BULTO POSTAL', destination_country: 'DO', summary_only: true, events: [
        { local_time: '2025-07-01', description: 'Entrada', stage: 'in_transit', stage_source: 'carrier_map' },
      ] });
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT NAME|0\.25|Ninguno/);
  });

  it('names the destination office as the pickup point once the status says the item is ready there', () => {
    const result = parseInposdom(withRows([row(ITEM, '2025-07-01', 'DISPONIBLE PARA RETIRO EN OFICINA')]), ITEM);
    expect(result).toMatchObject({ status: 'out_for_delivery', current_stage: 'ready_for_pickup',
      last_status_text: 'DISPONIBLE PARA RETIRO EN OFICINA', pickup_point: 'PUERTO PLATA\nAv. 12 de Julio esq. Separacion, Puerto Plata' });
    expect(parseInposdom(page('processing'), ITEM)).not.toHaveProperty('pickup_point');
  });

  it('keeps a status it cannot stage visible on the entry\'s stage, and a record without an entry date as its status alone', () => {
    expect(parseInposdom(withRows([row(ITEM, '2025-07-01', 'EN ESPERA DE DOCUMENTOS')]), ITEM)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'EN ESPERA DE DOCUMENTOS',
      events: [{ local_time: '2025-07-01', description: 'Entrada' }] });
    expect(parseInposdom(withRows([row(ITEM, '0000-00-00')]), ITEM)).toMatchObject({
      status: 'in_transit', last_status_text: 'PROCESANDO EN LA SEDE CENTRAL', summary_only: true, events: [] });
    expect(parseInposdom(withRows([row(ITEM, '2025-07-01', '')]), ITEM)).toMatchObject({ status: 'in_transit', last_status_text: 'Entrada' });
    expect(() => parseInposdom(withRows([row(ITEM, '', '')]), ITEM)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
  });

  it('reads the warning that answers the posted code as not found', async () => {
    expect(() => parseInposdom(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(once(reply(page('not-found')))).track({ number: UNKNOWN })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps only the whole code among the records its search finds, and refuses a changed or blocked page', () => {
    expect(parseInposdom(withRows([row(`${ITEM}1`), row(ITEM, '2025-06-30')]), ITEM).events)
      .toEqual([expect.objectContaining({ local_time: '2025-06-30' })]);
    expect(() => parseInposdom(withRows([row('EE123456789US')]), ITEM)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseInposdom(withRows([row(ITEM), row(ITEM, '2025-08-01')]), ITEM)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseInposdom(withRows([row(ITEM)], 2), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInposdom(withRows([row(ITEM, '2025-02-30')]), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInposdom(withRows([row(ITEM, '01/07/2025')]), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInposdom(withRows(['<tr><td>BULTO POSTAL</td></tr>']), ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInposdom(page('processing').replace('<th>Estatus</th>', '<th>Estado</th>'), ITEM))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    // The warning beside records, or worded otherwise, is no answer for the code.
    expect(() => parseInposdom(page('not-found').replace('</div></tbody>', `</div><table><tbody>${row(ITEM)}</tbody>`), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInposdom(page('not-found').replace('TU CODIGO', 'SU CODIGO'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInposdom(FORM, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseInposdom(FORM.replace('</form>', '</form>Búsqueda sin resultados'), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseInposdom(BLOCKED, ITEM)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseInposdom('<html><title>INPOSDOM</title></html>', ITEM)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps browser checks, refusals, moved routes and rate limits apart from a missing item, and retries a network failure once', async () => {
    await expect(carrier(once(reply(BLOCKED, 200))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(once(reply('', 403, { 'cf-mitigated': 'challenge' }))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(once(reply('Forbidden', 403))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(once(reply(BLOCKED, 503))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('', 503))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(once(reply('', 302, { Location: '/' }))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(once(reply('', 404))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(once(reply('', 429))).track({ number: ITEM })).rejects.toMatchObject({ kind: 'rate_limited' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(page('processing')));
    await expect(carrier(fetcher).track({ number: ITEM })).resolves.toMatchObject({ status: 'in_transit' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes S10 codes with a valid check digit and refuses anything else before a request', async () => {
    expect(normalizeInposdomNumber('lf065150446sg')).toBe(ITEM);
    for (const bad of ['LF065150447SG', 'LF06515044SG', '065150446', 'X'.repeat(65)]) {
      expect(() => normalizeInposdomNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'LF065150447SG' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage', () => {
    for (const entry of statuses.entries) {
      expect(inposdomStage(entry.wording), entry.wording).toEqual({ stage: entry.stage, source: 'carrier_map' });
      expect(statusMapAnswer({ carrier: 'inposdom', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});

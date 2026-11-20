import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, UsendTracker, usendTrackingUrl } from './adapter.js';
import { normalizeUsendNumber, parseUsend } from './parser.js';
import { statusMap, usendMappedStage, usendStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and the invented guide of the not-found page.
const SAMPLE = 'WB186756797';
const UNKNOWN = 'WB100000002';

const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body,
  { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
/** The sample's page with its guide history cut to the movements from `wording` on, the newest first. */
const cutTo = (wording: string) => {
  const html = page('delivered');
  const history = html.indexOf('<h6 class="card-title">Historial</h6>');
  const list = html.indexOf('<ul class="timeline timeline-split">', history) + '<ul class="timeline timeline-split">'.length;
  const movement = html.lastIndexOf('<li class="timeline-item">', html.indexOf(wording, list));
  const day = html.lastIndexOf('<li class="timeline-item period">', movement);
  const head = html.slice(day, html.indexOf('</li>', day) + '</li>'.length);
  return `${html.slice(0, list)}\n${head}\n${html.slice(movement)}`;
};

describe('USEND Chile HTTP adapter', () => {
  it('asks the guest tracker for the whole guide once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new UsendTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' wb 1867-56797 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://portal.usend.cl/rastrear-shipper/${SAMPLE}`);
    expect(usendTrackingUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      Accept: 'text/html,application/xhtml+xml', Referer: 'https://usend.cl/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(init).not.toHaveProperty('body');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'usend-chile', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('lists the guide’s movements newest first as agency wall clocks, staged by USEND’s wording', () => {
    const result = parseUsend(page('delivered'), SAMPLE);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTREGADO A TERCERO', last_update: null, last_update_local: '2024-06-21T14:03:00', expected_delivery: null });
    // The signed receipt's way back to the origin after the delivery is not the parcel's, and the piece's timeline repeats the guide's.
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage])).toEqual([
      ['2024-06-21T14:03:00', undefined, 'ENTREGADO A TERCERO', 'delivered'],
      ['2024-06-21T07:14:00', undefined, 'SALIO A ENTREGARSE (Primera Visita)', 'out_for_delivery'],
      ['2024-06-19T06:47:00', 'CONCEPCION', 'ARRIBO EN CIUDAD DESTINO', 'in_transit'],
      ['2024-06-18T22:07:00', 'SANTIAGO', 'DESPACHAMOS A SU DESTINO', 'in_transit'],
      ['2024-06-18T19:29:00', 'SANTIAGO', 'RECIBIMOS EN ORIGEN', 'accepted'],
      ['2024-06-18T15:53:00', undefined, 'SERVICIO CREADO', 'registered'],
    ]);
    expect(result.events!.every((event) => event.stage_source === 'carrier_map' && event.time === undefined && event.provider_code === undefined))
      .toBe(true);
    // Neither the signatory, the vehicle, the staff nor the bulk upload's request reach the result.
    expect(JSON.stringify(result)).not.toMatch(/X\. X\.|KVYP|usr_portal|236295|Firma|DNI|PK220570819CCP|Carga Masiva/);
  });

  it('reads a parcel on its way and its courier run from the history so far', () => {
    expect(parseUsend(cutTo('ARRIBO EN CIUDAD DESTINO'), SAMPLE)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit',
      last_status_text: 'ARRIBO EN CIUDAD DESTINO', last_update_local: '2024-06-19T06:47:00' });
    expect(parseUsend(cutTo('SERVICIO CREADO'), SAMPLE)).toMatchObject({ current_stage: 'registered', events: [expect.objectContaining({ local_time: '2024-06-18T15:53:00' })] });
    // A later visit stages as the first; a noon and a midnight clock read as the day's 12:xx and 00:xx.
    const second = cutTo('SALIO A ENTREGARSE (Primera Visita)').replaceAll('SALIO A ENTREGARSE (Primera Visita)', 'SALIO A ENTREGARSE (Segunda Visita)')
      .replaceAll('<span>7:14 am</span>', '<span>12:05 pm</span>');
    expect(parseUsend(second, SAMPLE).events![0]).toMatchObject({ local_time: '2024-06-21T12:05:00', stage: 'out_for_delivery', stage_source: 'carrier_map' });
    expect(parseUsend(second.replaceAll('<span>12:05 pm</span>', '<span>12:05 am</span>'), SAMPLE).events![0]).toMatchObject({ local_time: '2024-06-21T00:05:00' });
  });

  it('stages a wording USEND’s map does not know by the shared rules, and leaves one no rule knows without a stage', () => {
    const unknown = parseUsend(cutTo('ARRIBO EN CIUDAD DESTINO').replaceAll('>ARRIBO EN CIUDAD DESTINO<', '>NOTA DE MUESTRA<'), SAMPLE);
    expect(unknown.events![0]).toMatchObject({ description: 'NOTA DE MUESTRA', location: 'CONCEPCION' });
    expect(unknown.events![0]).not.toHaveProperty('stage');
    // The stage of the movement before it stands.
    expect(unknown).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'NOTA DE MUESTRA' });
    expect(usendStage('Entregado')).toMatchObject({ stage: 'delivered' });
    expect(usendStage('NOTA DE MUESTRA')).toBeNull();
  });

  it('reads a guide the tracker does not hold as not found, and another code’s same answer as inconclusive', () => {
    expect(() => parseUsend(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const code = page('not-found').replace(UNKNOWN, '100000003');
    expect(() => parseUsend(code, '100000003')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'portal_not_found' }));
    // A notice for another number settles nothing.
    expect(() => parseUsend(page('not-found'), 'WB100000004')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: undefined }));
  });

  it('keeps only the page that names the whole guide asked', () => {
    expect(() => parseUsend(page('delivered'), 'WB18675679')).toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'USEND answered for another shipment' }));
    expect(() => parseUsend(page('delivered'), 'WB1867567970')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a listed guide without movements as no history, and a changed page as a schema change', () => {
    const empty = page('delivered').replace(/(<h6 class="card-title">Historial<\/h6>[\s\S]*?<ul class="timeline timeline-split">)[\s\S]*?(<\/ul>)/, '$1$2');
    expect(() => parseUsend(empty, SAMPLE)).toThrow(expect.objectContaining({ name: 'NoHistoryError', reason: 'listed' }));
    expect(() => parseUsend(page('delivered').replace('>Historial<', '>Otra cosa<'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUsend(page('delivered').replaceAll('Tuesday, 18 de June del 2024', 'Sometime'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUsend(page('delivered').replaceAll('Tuesday, 18 de June del 2024', 'Tuesday, 31 de June del 2024'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUsend(page('delivered').replaceAll('<span>10:07 pm</span>', '<span>22:07</span>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUsend(page('delivered').replaceAll('<span>10:07 pm</span>', '<span>13:07 pm</span>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // A movement before any day.
    const dayless = cutTo('SERVICIO CREADO').replace(/<li class="timeline-item period">[\s\S]*?<\/li>(?=\s*<li class="timeline-item">\s*<div class="timeline-info">\s*<span>3:53 pm)/, '');
    expect(() => parseUsend(dayless, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseUsend('<html><body>Mantención</body></html>', SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads a browser check and refusals as such, never as a missing guide', async () => {
    const check = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(() => parseUsend(check, SAMPLE)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(check))).track({ number: SAMPLE }, { budgetMs: 1000 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('Forbidden', { status: 403 }))).track({ number: SAMPLE }, { budgetMs: 1000 }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('', { status: 429 }))).track({ number: SAMPLE }, { budgetMs: 1000 }))
      .rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('', { status: 302, headers: { Location: 'https://usend.cl/' } })))
      .track({ number: SAMPLE }, { budgetMs: 1000 })).rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('Not Found', { status: 404 }))).track({ number: SAMPLE }, { budgetMs: 1000 }))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page('not-found')))).track({ number: UNKNOWN }, { budgetMs: 1000 }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('tries once more after a network failure, within the budget', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(page('delivered')));
    await expect(carrier(fetcher).track({ number: SAMPLE }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts guides and codes of letters and digits only', () => {
    expect(normalizeUsendNumber(' wb-186 756 797 ')).toBe(SAMPLE);
    for (const raw of ['', 'WB12', 'WBWBWBWB', 'WB18675679/7', 'A'.repeat(21), `WB${'1'.repeat(70)}`]) {
      expect(() => normalizeUsendNumber(raw), raw).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('maps every status it knows, and leaves the signed receipt’s movements to the parser', () => {
    for (const entry of statuses.entries) {
      const stage = usendMappedStage(entry.wording);
      expect(stage, entry.wording).toBe('stage' in entry ? entry.stage : undefined);
      expect(statusMap.stage(null, entry.wording.toLowerCase()), entry.wording).toBe(stage);
      expect(statusMapAnswer({ carrier: 'usend-chile', description: entry.wording }), entry.wording)
        .toEqual(stage ? { kind: 'mapped', stage } : expect.objectContaining({ kind: expect.not.stringMatching(/^mapped$/) }));
    }
    expect(statusMap.stage('X', 'servicio creado')).toBeUndefined();
  });
});

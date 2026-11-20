import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { flechaStage } from './status.js';

export const PROVIDER = 'FlechaCarga';
export const FLECHA_SCRIPT = 'https://extranet.gestionbus.com.ar/Wordpress/tracking.js';
export const FLECHA_ENDPOINT = 'https://rest.empresar-sys.com.ar:1433/convenios/estadoDelivery/template';
export const MAX_BYTES = 2_000_000;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const MISSING = 'No se encontro la operacion con numero:';

export function flechaReference(raw: string): string {
  const number = raw.length <= 80 ? normalizeTrackingNumber(raw) : '';
  if (/^FLC\d{4}[A-Z]\d{1,8}$/.test(number)) throw new IndeterminateError(PROVIDER, 'The modern FLC guide route is outside this legacy receipt reader');
  const parts = /^([A-Z])(\d{4})(\d{1,16})$/.exec(number);
  if (!parts || !Number.isSafeInteger(Number(parts[3]))) throw new InvalidInputError(PROVIDER, 'FlechaCarga takes a legacy letter, branch and receipt serial');
  // The native limpiarNroComp keeps the branch and sends the serial through Number().
  return `${parts[1]}-${parts[2]}-${Number(parts[3])}`;
}

export function publicTrackingToken(script: string): string {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied)/i.test(script)) throw new ChallengeError(PROVIDER, 'The public tracking script returned a browser check');
  const matches = [...script.matchAll(/^\s*(?:var|let|const)\s+token\s*=\s*(['"])([A-Za-z0-9_.=+/-]{16,2048})\1\s*;/gm)];
  if (matches.length !== 1 || !script.includes(FLECHA_ENDPOINT) || !/function\s+buscar\s*\(/.test(script)) {
    throw new SchemaError(PROVIDER, 'FlechaCarga changed its public guest tracking script');
  }
  return matches[0]![2]!;
}

function clock(raw: string): string {
  if (!/^\d{2}\/\d{2}\/20\d{2} \d{2}:\d{2}$/.test(raw)) throw new SchemaError(PROVIDER, 'FlechaCarga changed a scan clock');
  // UTC checks the calendar only. The service states no offset for its minute wall clocks.
  const date = DateTime.fromFormat(raw, 'dd/MM/yyyy HH:mm', { zone: 'UTC' });
  if (!date.isValid || date.toFormat('dd/MM/yyyy HH:mm') !== raw) throw new SchemaError(PROVIDER, 'FlechaCarga returned an invalid scan calendar');
  return date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

export function parseFlecha(text: string, raw: string): CarrierResult {
  const reference = flechaReference(raw);
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied)/i.test(text.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'FlechaCarga returned a browser check');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new SchemaError(PROVIDER, 'FlechaCarga returned unreadable tracking data'); }
  if (record(data) && data.estado === -1 && Object.keys(data).length === 2 && data.mensaje === MISSING + reference) throw new NotFoundError(PROVIDER);
  if (!record(data) || data.estado !== 1 || !record(data.template) || data.template.estado !== 1
      || typeof data.template.template !== 'string' || data.template.template.length > 1_000_000) {
    throw new SchemaError(PROVIDER, 'FlechaCarga changed its shipment reply');
  }
  const $ = load(data.template.template);
  const brand = /\bbus\s*pack\b|\bflecha\s*carga\b/i;
  if (typeof data.template.titulo !== 'string' || data.template.titulo.length > 200
      || !brand.test(data.template.titulo) || !brand.test($('title').text())) {
    throw new IndeterminateError(PROVIDER, 'The shared service did not confirm the Buspack or FlechaCarga network');
  }
  const headings = $('body > div').filter((_i, element) => $(element).children().length === 0
    && $(element).text().trim().startsWith('Nro. de comprobante:'));
  if (headings.length !== 1 || headings.text().trim() !== 'Nro. de comprobante: ' + reference) {
    throw new IndeterminateError(PROVIDER, 'FlechaCarga did not bind the whole receipt');
  }
  const tables = $('table').filter((_i, element) => $(element).find('tr').first().find('th').toArray()
    .map(cell => $(cell).text().trim()).join('|') === 'Fecha|Estado');
  if (tables.length !== 1) throw new SchemaError(PROVIDER, 'FlechaCarga changed its history table');
  const rows = tables.find('tr').toArray().filter(row => $(row).find('td').length > 0);
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'FlechaCarga returned no dated receipt milestones');
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'FlechaCarga returned an oversized history');
  const events: CarrierEvent[] = rows.map(row => {
    const cells = $(row).find('td');
    if (cells.length !== 2) throw new SchemaError(PROVIDER, 'FlechaCarga changed a history row');
    const wording = cells.eq(1).text().replace(/\s+/g, ' ').trim();
    const stage = flechaStage(wording);
    if (!stage) throw new SchemaError(PROVIDER, 'FlechaCarga returned an unsupported milestone');
    return { time: clock(cells.eq(0).text().trim()), description: wording, stage, stage_source: 'carrier_map' };
  });
  events.sort((a, b) => b.time!.localeCompare(a.time!));
  const latest = events[0]!, stage = flechaStage(latest.description!)!;
  return { status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update: null, last_update_local: latest.time,
    expected_delivery: null, events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}

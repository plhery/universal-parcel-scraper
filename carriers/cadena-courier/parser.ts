import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { scanStages } from './status.js';

export const provider = 'cadena-courier';

function checkChallenge(body: string) {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)|verify (?:that )?you are human|class=["'][^"']*\bg-recaptcha\b/i.test(body)) {
    throw new ChallengeError(provider, 'Cadena Courier requires verification');
  }
}

export function formState(body: string): URLSearchParams {
  checkChallenge(body);
  const $ = load(body);
  const fields = new URLSearchParams();
  $('#aspnetForm input[type="hidden"][name]').each((_, e) => {
    const name = $(e).attr('name');
    if (name) fields.set(name, $(e).attr('value') ?? '');
  });
  if (!fields.get('__VIEWSTATE') || !fields.get('__EVENTVALIDATION')) {
    throw new SchemaError(provider, 'Cadena Courier omitted its guest form state');
  }
  return fields;
}

export function verifySearch(body: string, number: string): void {
  checkChallenge(body);
  const $ = load(body);
  const grid = $('table[id$="_ASPxGridDetalle_DXMainTable"]');
  if (grid.length !== 1) throw new SchemaError(provider, 'Cadena Courier omitted its shipment grid');
  const rows = grid.find('tr[id*="_ASPxGridDetalle_DXDataRow"]');
  if (!rows.length && clean(grid.find('tr[id$="_ASPxGridDetalle_DXEmptyRow"]').text()) === 'No hay datos para mostrar') {
    throw new NotFoundError(provider);
  }
  const row = rows.first();
  if (rows.length !== 1 || !row.attr('id')?.endsWith('_DXDataRow0') || clean(row.children('td').first().text()) !== number) {
    throw new IndeterminateError(provider, 'Cadena Courier did not confirm the exact guide in its first result row');
  }
}

function callbackHtml(body: string): string {
  checkChallenge(body);
  const text = body.match(/\/\*DX\*\/\s*\(\{\s*'result'\s*:\s*'((?:\\[\s\S]|[^'\\])*)'/)?.[1];
  if (!text) throw new SchemaError(provider, 'Cadena Courier omitted the guest detail HTML');
  const escaped = text.replace(/\\(?:x[0-9a-fA-F]{2}|[\s\S])|"/g, part => {
    if (part === '"') return '\\"';
    if (part === "\\'" || part === '\\-') return part.slice(1);
    return part.startsWith('\\x') ? '\\u00' + part.slice(2) : part;
  });
  try {
    return JSON.parse('"' + escaped + '"') as string;
  } catch {
    throw new SchemaError(provider, 'Cadena Courier sent an invalid guest detail payload');
  }
}

function movementTime(value: string) {
  const clock = value.replace(/\s*([ap])\.\s*m\.$/i, (_, part: string) => ' ' + part.toUpperCase() + 'M');
  const withTime = clock.includes(':');
  const hasSeconds = /:\d{2}:\d{2}\b/.test(clock);
  const hasAmPm = / [AP]M$/.test(clock);
  const format = !withTime ? 'd/M/yyyy'
    : 'd/M/yyyy ' + (hasAmPm ? 'h' : 'H') + ':mm' + (hasSeconds ? ':ss' : '') + (hasAmPm ? ' a' : '');
  const local = DateTime.fromFormat(clock, format, { zone: 'utc', locale: 'en' });
  if (!local.isValid) throw new SchemaError(provider, 'Cadena Courier returned an invalid movement clock');
  return withTime ? local.toFormat("yyyy-MM-dd'T'HH:mm" + (hasSeconds ? ':ss' : '')) : local.toFormat('yyyy-MM-dd');
}

export function parseTracking(body: string, number: string): CarrierResult {
  const html = callbackHtml(body);
  const $ = load(html);
  if (clean($('[id$="_ASPxFormLayout1_txguia1"]').text()) !== number) {
    throw new IndeterminateError(provider, 'Cadena Courier opened information for a different guide');
  }
  const history = $('table[id$="_GrTracking_DXMainTable"]');
  if (history.length !== 1) throw new SchemaError(provider, 'Cadena Courier omitted its movement grid');

  const events = new Map<string, CarrierEvent & { stage?: Stage }>();
  for (const row of history.find('tr[id*="_GrTracking_DXDataRow"]').toArray()) {
    const cells = $(row).children('td').toArray();
    if (cells.length !== 3) throw new SchemaError(provider, 'Cadena Courier changed the movement columns');
    const [location, clock, description] = cells.map(e => clean($(e).text()));
    if (!description || !clock) throw new SchemaError(provider, 'Cadena Courier returned a movement without a description or time');
    if (hasPrivateDeliveryDetails(description)) continue;
    const localTime = movementTime(clock);
    const city = location && /^[\p{L}\p{M} .'-]{1,80}$/u.test(location) ? location : undefined;
    const stage = scanStages.get(description.toUpperCase());
    events.set(JSON.stringify([localTime, description, city]), {
      local_time: localTime, description,
      ...(city && { location: city }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }

  const scans = [...events.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const latest = scans[0];
  if (!latest) throw new IndeterminateError(provider, 'Cadena Courier listed the guide without dated movements', { reason: 'listed' });
  const stage = latest.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events: scans,
  };
}

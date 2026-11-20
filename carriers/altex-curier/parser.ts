import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { altexStage } from './status.js';

export const PROVIDER = 'Altex Curier';
export const ALTEX_ORIGIN = 'https://curier.altex.ro';
export const ALTEX_MAX_BYTES = 500_000;

export function altexNumber(raw: string): string {
  const number = raw.length <= 40 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{8,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Altex Curier takes a numeric AWB');
  return number;
}

export function altexTrackingUrl(raw: string): string {
  return ALTEX_ORIGIN + '/tracking.aspx?' + new URLSearchParams({ AWB: altexNumber(raw) }).toString();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function calendar(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{2}\.\d{2}\.20\d{2}$/.test(value)) {
    throw new SchemaError(PROVIDER, 'Altex Curier changed its scan date');
  }
  // UTC validates only calendar fields; this endpoint supplies a day, not a clock.
  const date = DateTime.fromFormat(value, 'dd.MM.yyyy', { zone: 'UTC' });
  if (!date.isValid || date.toFormat('dd.MM.yyyy') !== value) throw new SchemaError(PROVIDER, 'Altex Curier returned an invalid calendar day');
  return date.toFormat('yyyy-MM-dd');
}

export function parseAltex(html: string, raw: string): CarrierResult {
  const number = altexNumber(raw);
  if (/_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'Altex Curier answered with a browser check');
  }
  const $ = load(html);
  if (clean($('title').text()) !== PROVIDER) throw new SchemaError(PROVIDER, 'Altex Curier changed its result page');
  const headings = $('h2').filter((_index, heading) => /^Detalii AWB:/.test(clean($(heading).text())));
  if (headings.length !== 1 || clean(headings.text()) !== 'Detalii AWB: ' + number) {
    throw new IndeterminateError(PROVIDER, 'Altex Curier did not return the requested AWB heading');
  }
  const calls: string[] = [];
  $('script:not([src])').each((_index, node) => {
    const script = $(node).html() ?? '';
    if (!/\bdisplayTrackingData\s*\(/.test(script)) return;
    const match = /^\s*(?:\/\/<!\[CDATA\[\s*)?displayTrackingData\s*\(\s*(\[[\s\S]*\])\s*\)\s*;\s*(?:\/\/\]\]>\s*)?$/.exec(script);
    if (!match) throw new SchemaError(PROVIDER, 'Altex Curier changed its native event assignment');
    calls.push(match[1]!);
  });
  if (calls.length !== 1) throw new SchemaError(PROVIDER, 'Altex Curier returned no unique native event list');
  let rows: unknown;
  try { rows = JSON.parse(calls[0]!); } catch { throw new SchemaError(PROVIDER, 'Altex Curier returned invalid event data'); }
  if (!Array.isArray(rows) || !rows.length) throw new IndeterminateError(PROVIDER, 'Altex Curier returned no shipment events');
  if (rows.length > 500 || !rows.every(record)) throw new SchemaError(PROVIDER, 'Altex Curier changed its event list');
  if (rows.some(row => row.isError === true)) {
    if (rows.length === 1 && rows[0]!.isError === true && rows[0]!.AWB === number
      && Object.keys(rows[0]!).every(key => ['AWB', 'isError'].includes(key))) throw new NotFoundError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Altex Curier returned a conflicting or unbound error');
  }
  const events: CarrierEvent[] = rows.map(row => {
    if (row.isError !== false || typeof row.Title !== 'string' || !row.Title.trim() || row.Title.length > 300) {
      throw new SchemaError(PROVIDER, 'Altex Curier changed its event wording');
    }
    const description = clean(row.Title, 300), stage = altexStage(description);
    return { local_time: calendar(row.Date), description, ...(stage ? { stage, stage_source: 'explicit_mapping' } : {}) };
  }).reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0]!, stage = altexStage(latest.description!);
  return { status: stage ? languageStageStatus(stage) : 'unknown', current_stage: stage ?? 'unknown',
    current_stage_source: stage ? 'explicit_mapping' : 'none', last_status_text: latest.description!,
    last_update: null, last_update_local: latest.local_time!, expected_delivery: null,
    events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}

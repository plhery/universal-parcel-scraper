import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { xlsFutarStage } from './status.js';

export const PROVIDER = 'XLS Futár';
export const XLS_FUTAR_ORIGIN = 'https://xlsfutar.hu';
export const XLS_FUTAR_MAX_BYTES = 400_000;

export function normalizeXlsFutarNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^\d{1,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'XLS Futár tracking takes a parcel number');
  return number;
}

export function xlsFutarTrackingUrl(raw: string): string {
  return XLS_FUTAR_ORIGIN + '/track/' + normalizeXlsFutarNumber(raw);
}

/** The number-only guest result is a current summary, not a list of scans. */
export function parseXlsFutar(html: string, raw: string): CarrierResult {
  const number = normalizeXlsFutarNumber(raw);
  if (/_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'XLS Futár answered with a browser check');
  }
  const $ = load(html); $('script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
  const content = $('main .content');
  if (content.length !== 1) throw new SchemaError(PROVIDER, 'XLS Futár changed its tracking page');
  const form = content.find('form').filter((_index, node) => $(node).attr('action') === XLS_FUTAR_ORIGIN + '/track');
  if (form.length !== 1 || form.attr('method')?.toUpperCase() !== 'GET' || form.find('input[name="id"]').length !== 1) {
    throw new SchemaError(PROVIDER, 'XLS Futár changed its tracking form');
  }
  if (form.find('input[name="id"]').attr('value')?.trim() !== number) {
    throw new IndeterminateError(PROVIDER, 'XLS Futár answered for another reference');
  }
  const path = content.find('.order-state-path'), alert = content.find('.alert');
  if (alert.length === 1 && /^Nem létező csomagszám\s+Kérjük vegye fel a kapcsolatot a feladóval!$/.test(clean(alert.text()))) {
    if (path.length) throw new IndeterminateError(PROVIDER, 'XLS Futár returned conflicting tracking outcomes');
    throw new NotFoundError(PROVIDER);
  }
  if (path.length !== 1) throw new IndeterminateError(PROVIDER, 'XLS Futár did not complete its public summary');
  const active = path.find('.col.active .label');
  if (active.length !== 1) throw new SchemaError(PROVIDER, 'XLS Futár returned no unique current state');
  const wording = clean(active.text(), 200);
  if (!wording) throw new SchemaError(PROVIDER, 'XLS Futár returned no current wording');
  const label = content.find('.col-md-5').filter((_index, node) => clean($(node).text()) === 'Utolsó változás');
  if (label.length !== 1) throw new SchemaError(PROVIDER, 'XLS Futár returned no unique last-change date');
  const value = clean(label.next('.col-md-7').text(), 100);
  const match = /^(20\d{2}-\d{2}-\d{2})(?:\s+\([^()]*\))?$/.exec(value);
  if (!match) throw new SchemaError(PROVIDER, 'XLS Futár changed its last-change date');
  // UTC validates the calendar day; it is not a zone applied to this date-only field.
  const day = match[1]!, date = DateTime.fromFormat(day, 'yyyy-MM-dd', { zone: 'UTC' });
  if (!date.isValid || date.toFormat('yyyy-MM-dd') !== day) throw new SchemaError(PROVIDER, 'XLS Futár returned an invalid date');
  const staged = xlsFutarStage(wording);
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown', current_stage: staged?.stage ?? 'unknown',
    current_stage_source: staged?.source ?? 'none', last_status_text: wording, last_update: null, last_update_local: day,
    expected_delivery: null, events: [], summary_only: true };
}

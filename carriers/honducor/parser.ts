import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { honducorStage } from './status.js';
import { honducorWording } from './wording.js';

export { honducorWording } from './wording.js';

export const PROVIDER = 'Honducor';
export const HONDUCOR_ORIGIN = 'https://rastreo.honducor.gob.hn';
export const HONDUCOR_MAX_BYTES = 900_000;

export function normalizeHonducorNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Honducor tracking takes a postal reference');
  return number;
}

function document(html: string) {
  if (/_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'Honducor answered with a browser check');
  }
  const $ = load(html);
  $('script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
  return $;
}

export function honducorForm(html: string): URLSearchParams {
  const $ = document(html), form = $('form#trackingForm');
  if (form.length !== 1 || form.attr('method')?.toLowerCase() !== 'post' || form.attr('action') !== '/rastreo'
    || form.find('input[name="tracking_number"]').length !== 1) throw new SchemaError(PROVIDER, 'Honducor changed its tracking form');
  const widget = form.find('altcha-widget');
  if (widget.length !== 1 || widget.attr('challenge') !== '/rastreo/altcha/challenge' || widget.attr('name') !== 'altcha'
    || widget.attr('verifyurl')) throw new ChallengeError(PROVIDER, 'Honducor changed its guest security check');
  const fields = new URLSearchParams();
  form.find('input[type="hidden"][name]').each((_index, input) => {
    const key = $(input).attr('name')!;
    if (fields.has(key) || !['csrf_token'].includes(key)) throw new SchemaError(PROVIDER, 'Honducor changed its form state');
    fields.set(key, $(input).attr('value') ?? '');
  });
  return fields;
}

/** The one result navigation the guest form returns, bound to the whole submitted reference. */
export function honducorResultUrl(location: string | null, number: string): string {
  let url: URL;
  try { url = new URL(location ?? '', HONDUCOR_ORIGIN); }
  catch { throw new SchemaError(PROVIDER, 'Honducor returned an invalid result navigation'); }
  if (url.origin !== HONDUCOR_ORIGIN || url.username || url.password || url.pathname !== '/rastreo' || url.hash
    || [...url.searchParams].length !== 1 || url.searchParams.get('tracking_number') !== number) {
    throw new IndeterminateError(PROVIDER, 'Honducor did not navigate to the requested reference');
  }
  return url.href;
}

function clock(value: string): string {
  if (!/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new SchemaError(PROVIDER, 'Honducor returned an invalid event clock');
  // UTC checks the calendar fields; it is not applied to the carrier's clock.
  const parsed = DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat('yyyy-MM-dd HH:mm:ss') !== value) throw new SchemaError(PROVIDER, 'Honducor returned an invalid event clock');
  return value.replace(' ', 'T');
}

export function parseHonducor(html: string, raw: string): CarrierResult {
  const number = normalizeHonducorNumber(raw), $ = document(html);
  const summary = $('.pt_summary');
  if (summary.length > 1) throw new IndeterminateError(PROVIDER, 'Honducor returned several results');
  if (!summary.length) {
    const alert = clean($('.pt_alert').text(), 300);
    if (/verificaci[oó]n|ALTCHA|captcha/i.test(alert)) throw new ChallengeError(PROVIDER, 'Honducor did not accept its security check');
    throw new IndeterminateError(PROVIDER, 'Honducor did not complete its tracking result');
  }
  const identity = summary.find('.pt_box').filter((_index, box) => clean($(box).find('strong').text()) === 'Guía');
  if (identity.length !== 1) throw new SchemaError(PROVIDER, 'Honducor returned no unique result identity');
  const owned = identity.clone(); owned.find('strong').remove();
  if (normalizeTrackingNumber(clean(owned.text())) !== number) throw new IndeterminateError(PROVIDER, 'Honducor answered for another reference');
  const state = summary.find('.pt_state');
  if (state.length !== 1) throw new SchemaError(PROVIDER, 'Honducor returned no unique shipment state');
  const summaryText = clean(state.text(), 240);
  const container = $('.pt_events');
  if (container.length > 1) throw new IndeterminateError(PROVIDER, 'Honducor returned several event lists');
  const rows = container.find('article.pt_event');
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Honducor returned an oversized history');
  const events: CarrierEvent[] = [];
  rows.each((_index, row) => {
    const item = $(row);
    if (item.find('.pt_date').length !== 1 || item.find('.pt_desc').length !== 1 || item.find('.pt_meta').length !== 1) {
      throw new SchemaError(PROVIDER, 'Honducor changed its event layout');
    }
    const local = clock(clean(item.find('.pt_date').text(), 60));
    const description = honducorWording(item.find('.pt_desc').text());
    if (!description) throw new SchemaError(PROVIDER, 'Honducor returned an event without wording');
    const meta = clean(item.find('.pt_meta').text(), 240);
    if (meta && !/^Ubicación:/.test(meta)) throw new SchemaError(PROVIDER, 'Honducor changed its event location');
    const location = clean(meta.replace(/^Ubicación:\s*/, '').split('·', 1)[0] ?? '', 160);
    const staged = honducorStage(description);
    events.push({ local_time: local, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // This public portal also relays foreign postal events. A result must include
  // a Honduras office, rather than confirm Honducor from a foreign history alone.
  if (!events.some(event => /^HN[A-Z]{3}[A-Z0-9]$/.test(event.location?.toUpperCase() ?? ''))) {
    throw new NoHistoryError(PROVIDER, 'Honducor returned no Honduras postal scan', { reason: 'external_history' });
  }
  const ordered = events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const staged = honducorStage(summaryText) ?? ordered.map(event => honducorStage(event.description!)).find(stage => stage !== null);
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown', current_stage: staged?.stage ?? 'unknown',
    current_stage_source: staged?.source ?? 'none', last_status_text: ordered[0]!.description!,
    last_update: null, last_update_local: ordered[0]!.local_time, expected_delivery: null,
    events: ordered.slice(0, 100), ...(ordered.length > 100 ? { history_truncated: true } : {}) };
}

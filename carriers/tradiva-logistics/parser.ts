import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { tradivaStage } from './status.js';

const carrier = 'tradiva-logistics';
const referenceLabels = new Set(['رقم الحاوية', 'بوليصة الشحن (B/L)', 'بوليصة الشحن الجوي (AWB)']);
const etaLabel = 'تاريخ الوصول المتوقع (ETA)';
const arabicCalendar = { locale: 'ar-EG', numberingSystem: 'latn', zone: 'UTC' };

function normalizeReference(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Tradiva returned a browser check');
  }
  const $ = load(html);
  const result = $('#tdv-trk-result');
  if (result.length === 1 && clean(result.find('.tdv-trk-msg-error').text()).startsWith('لم يتم العثور على شحنة بهذا الرقم.')) {
    throw new NotFoundError(carrier);
  }
  const card = result.children('.tdv-trk-shipment');
  const header = card.children('.tdv-trk-head');
  const mainRef = clean(header.find('.tdv-trk-number').text(), 80);
  const current = clean(header.find('.tdv-trk-status').text(), 180);
  if (result.length !== 1 || card.length !== 1 || header.length !== 1 || !mainRef || !current) {
    throw new SchemaError(carrier, 'Tradiva changed its shipment summary');
  }

  const references = [mainRef];
  let expectedDelivery: string | null = null;
  for (const item of card.find('dl.tdv-trk-details > .tdv-trk-detail').toArray()) {
    const label = clean($(item).children('dt').text(), 120);
    const value = clean($(item).children('dd').text(), 100);
    if (referenceLabels.has(label) && value) references.push(value);
    if (label === etaLabel && value) expectedDelivery = DateTime.fromFormat(value, 'd MMMM yyyy', arabicCalendar).toISODate();
  }
  const target = normalizeReference(number);
  if (!references.some(value => normalizeReference(value) === target)) {
    throw new IndeterminateError(carrier, 'Tradiva returned a different tracking or freight reference');
  }

  const rows = card.find('ol.tdv-trk-timeline > li');
  if (rows.length > 500) throw new SchemaError(carrier, 'Tradiva returned too many tracking rows');
  const events: (CarrierEvent & { local_time: string })[] = [];
  for (const row of rows.toArray()) {
    const top = $(row).find('.tdv-trk-tl-top');
    const description = clean(top.children('strong').text(), 180);
    const location = clean($(row).find('.tdv-trk-tl-loc').text(), 120);
    const stamp = clean(top.children('time').text(), 60);
    const date = DateTime.fromFormat(stamp, 'd MMMM yyyy - h:mm a', arabicCalendar);
    if (top.length !== 1 || !description || !date.isValid) {
      throw new SchemaError(carrier, 'Tradiva changed its event wording or local clock');
    }
    const stage = tradivaStage(description);
    events.push({
      description, local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"),
      ...(stage && { stage, stage_source: 'explicit_mapping' }), ...(location && { location }),
    });
  }
  events.sort((left, right) => right.local_time.localeCompare(left.local_time));
  const stage = tradivaStage(current);
  const service = clean(header.find('.tdv-trk-mode').text(), 90);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: current, last_update: null, ...(events[0] && { last_update_local: events[0].local_time }),
    expected_delivery: expectedDelivery, ...(service && { service_name: service }),
    events: events.slice(0, 100), ...(!events.length && { summary_only: true }),
    ...(events.length > 100 && { history_truncated: true }),
  };
}

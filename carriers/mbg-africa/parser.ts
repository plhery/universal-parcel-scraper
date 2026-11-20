import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { withTieOrder } from '../../core/result/order.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { mbgStage } from './status.js';

const carrier = 'mbg-africa';
const dateOptions = { locale: 'en', zone: 'UTC' };

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'MBG-Africa returned a browser check');
  }
  const $ = load(html);
  const field = $('form[method="GET"] input[name="tn"]');
  if (clean($('title').text()) !== 'Track Shipment | MBG-Africa' || field.length !== 1) {
    throw new SchemaError(carrier, 'MBG-Africa changed its guest tracking form');
  }

  const identity = $('.card-n .tagline').filter((_index, node) => clean($(node).text()) === 'Tracking Number').next('.fw-bold');
  if (!identity.length && field.val() === number
    && clean($('.alert-err').text()).startsWith('No shipment found for this tracking number.')) {
    throw new NotFoundError(carrier);
  }
  if (identity.length !== 1) throw new SchemaError(carrier, 'MBG-Africa omitted the shipment reference');
  if (clean(identity.text()).toUpperCase() !== number) {
    throw new IndeterminateError(carrier, 'MBG-Africa returned a different shipment reference');
  }

  const header = identity.closest('.card-n');
  const summaries = header.find('.badge-status');
  const summary = clean(summaries.text(), 140);
  const labels = new Map(header.find('.tagline').toArray().map((node) => [
    clean($(node).text()), clean($(node).next('.fw-semibold').text(), 160),
  ]));
  const history = $('.card-n > h3').filter((_index, node) => clean($(node).text()) === 'Shipment History').parent();
  const rows = history.children('.track-step.done');
  if (!summary || summaries.length !== 1 || history.length !== 1 || rows.length > 500) {
    throw new SchemaError(carrier, 'MBG-Africa changed its shipment summary or history');
  }

  const events = rows.toArray().reverse().map((node): CarrierEvent & { local_time: string } => {
    const row = $(node);
    const clock = row.find('.t-date');
    const title = row.find('.t-title');
    const local = DateTime.fromFormat(clean(clock.text()), "d MMM yyyy '—' HH:mm", dateOptions);
    const description = clean(title.text(), 180);
    if (clock.length !== 1 || title.length !== 1 || !local.isValid || !description) {
      throw new SchemaError(carrier, 'MBG-Africa changed its milestone time or wording');
    }
    const stage = mbgStage(description);
    const location = clean(row.find('.t-loc').text(), 160);
    return {
      local_time: local.toFormat("yyyy-MM-dd'T'HH:mm"), description,
      ...(location && { location }), ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));
  withTieOrder(events);

  const stage = mbgStage(summary);
  const current = events[0];
  const eta = DateTime.fromFormat(labels.get('ETA') ?? '', 'd MMM yyyy', dateOptions).toISODate();
  const service = labels.get('Transport Mode');
  const destination = labels.get('Destination Country')?.split(',').at(-1)?.trim();
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: summary, last_update: null,
    ...(current ? { last_update_local: current.local_time } : { summary_only: true }),
    ...(eta && { expected_delivery: eta }),
    ...(service && { service_name: service }),
    ...(destination && { destination_country_name: destination }),
    events: events.slice(0, 100), ...(events.length > 100 && { history_truncated: true }),
  };
}

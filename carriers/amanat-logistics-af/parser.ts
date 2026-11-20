import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { withTieOrder } from '../../core/result/order.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { amanatStage } from './status.js';

const carrier = 'amanat-logistics-af';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Amanat Logistics returned a browser check');
  }
  const $ = load(html);
  const main = $('main');
  const form = main.find('form[action="/tracking/orders"]');
  if (form.length !== 1) throw new SchemaError(carrier, 'Amanat Logistics changed its guest tracking form');
  const timeline = main.find('ol.tk-timeline');
  if (!timeline.length && main.text().includes('No order found for')
    && main.find('bdi').toArray().some((element) => clean($(element).text()).toUpperCase() === number)) {
    throw new NotFoundError(carrier);
  }
  if (timeline.length !== 1) throw new SchemaError(carrier, 'Amanat Logistics changed its shipment progress panel');

  const details = new Map(main.find('dl dt').toArray().map((item) => [clean($(item).text(), 90), clean($(item).next('dd').text(), 160)]));
  const tracking = details.get('Tracking Number');
  const invoice = details.get('ACCI Invoice No');
  if (!tracking) throw new SchemaError(carrier, 'Amanat Logistics omitted the tracking number');
  if (![tracking, invoice ?? ''].some((value) => value.toUpperCase() === number)) {
    throw new IndeterminateError(carrier, 'Amanat Logistics returned a different shipment number');
  }

  const visible = timeline.children('li.tk-step');
  const completed = visible.filter('.tk-completed, .tk-active');
  const active = completed.filter('.tk-active');
  if (active.length !== 1 || completed.last()[0] !== active[0] || completed.length > 100) {
    throw new SchemaError(carrier, 'Amanat Logistics changed its completed tracking steps');
  }
  const events: (CarrierEvent & { description: string; stage?: Stage })[] = [];
  let earlierLatest: string | undefined;
  for (const item of completed) {
    const row = $(item);
    const title = row.children('.tk-title');
    const clock = row.children('.tk-time');
    const description = clean(title.text(), 180).replace(/^\d+\.\s+/, '');
    const printed = clean(clock.text(), 40);
    if (title.length !== 1 || clock.length !== 1 || !description || !printed) {
      throw new SchemaError(carrier, 'Amanat Logistics changed its progress step wording or date');
    }
    const day = printed === '—' ? null : DateTime.fromFormat(printed, 'd MMM yyyy', { locale: 'en', zone: 'UTC' }).toISODate();
    if (printed !== '—' && !day) throw new SchemaError(carrier, 'Amanat Logistics returned an invalid progress date');
    const stage = amanatStage(description);
    const conflictingCurrentDay = row.hasClass('tk-active') && day && earlierLatest && day < earlierLatest;
    events.push({
      description,
      ...(day && !conflictingCurrentDay && { local_time: day }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    });
    if (day && (!earlierLatest || day > earlierLatest)) earlierLatest = day;
  }
  events.reverse();
  withTieOrder(events);
  const current = events[0]!;
  const weight = /^(\d+(?:,\d{3})*(?:\.\d+)?) kg$/i.exec(details.get('Gross Weight') ?? '');
  const weightKg = weight ? Number(weight[1]!.replaceAll(',', '')) : null;
  return {
    status: current.stage ? languageStageStatus(current.stage) : 'unknown',
    ...(current.stage && { current_stage: current.stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: current.description, last_update: null,
    ...(current.local_time && { last_update_local: current.local_time }),
    ...(weightKg !== null && Number.isFinite(weightKg) && { weight_kg: weightKg }),
    ...(tracking !== number && { canonical_tracking_number: tracking }),
    events,
  };
}

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { scanLocations, scanStages } from './status.js';

export const provider = 'confirmed-freight';

export function parseTracking(raw: string, number: string): CarrierResult {
  if (/<title>\s*(?:Access Denied|Just a moment|Security Check)|cf-chl|_Incapsula_Resource/i.test(raw)) {
    throw new ChallengeError(provider, 'Confirmed Freight requires verification');
  }
  const $ = load(raw);
  const missing = clean($('table.minimum').text()).match(/couldn't locate any information on tracking number ([A-Z0-9._-]+)\.\s+Please check back/i);
  if (missing) {
    if (missing[1]?.toUpperCase() === number.toUpperCase()) throw new NotFoundError(provider);
    throw new IndeterminateError(provider, 'Confirmed Freight answered for a different reference');
  }
  const reference = $('td.tr_num');
  if (reference.length !== 1) throw new SchemaError(provider, 'Confirmed Freight omitted the shipment reference');
  if (clean(reference.text()).toUpperCase() !== number.toUpperCase()) {
    throw new IndeterminateError(provider, 'Confirmed Freight returned a different shipment');
  }

  const events: CarrierEvent[] = [];
  let date = '';
  for (const scan of $('table.tracking tr').toArray()) {
    const cells = $(scan).children('td');
    if (cells.length !== 4) continue;
    date = clean(cells.eq(0).text()) || date;
    const description = clean(cells.eq(1).text());
    if (!description || hasPrivateDeliveryDetails(description)) continue;
    const clock = clean(cells.eq(3).text());
    const timestamp = DateTime.fromFormat(date + ' ' + clock, 'ccc, LLL d yyyy h:mm a', { zone: 'utc', locale: 'en-US' });
    if (!timestamp.isValid) throw new SchemaError(provider, 'Confirmed Freight returned an invalid movement clock');
    const stage = scanStages.get(description);
    const location = scanLocations.get(description);
    events.push({
      description, local_time: timestamp.toFormat("yyyy-MM-dd'T'HH:mm"),
      ...(stage && { stage, stage_source: 'carrier_map' }),
      ...(location && { location }),
    });
  }
  events.sort((first, second) => (second.local_time ?? '').localeCompare(first.local_time ?? ''));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Confirmed Freight listed the shipment without dated movements', { reason: 'listed' });
  const stage = scanStages.get(latest.description ?? '');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

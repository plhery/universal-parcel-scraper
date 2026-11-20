import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'hrl-cargo';

function localDay(raw: unknown): string | undefined {
  const date = clean(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return DateTime.fromISO(date, { zone: 'utc' }).isValid ? date : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  if (!$('form input[name="docno"]').length) throw new SchemaError(provider, 'HRL Cargo did not return its tracking page');
  const card = $('.track-result');
  const docket = clean(card.find('.track-number').text());
  if (docket.toUpperCase() !== number.toUpperCase()) {
    throw new IndeterminateError(provider, 'HRL Cargo did not return the requested docket');
  }

  const summary = clean(card.find('.track-badge').text());
  const current = stages.get(summary.toLowerCase());
  const events: CarrierEvent[] = [];
  for (const row of card.find('.track-stages .track-stage').toArray()) {
    const description = clean($(row).find('b').text());
    const date = localDay($(row).find('time').attr('datetime'));
    if (!description || !date || hasPrivateDeliveryDetails(description)) continue;
    const location = clean($(row).find('.track-where').text());
    const stage = stages.get(description.toLowerCase());
    events.push({
      description, local_time: date, ...(location && !hasPrivateDeliveryDetails(location) && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }
  events.reverse();
  if (!events.length && !current) {
    throw new IndeterminateError(provider, 'HRL Cargo listed the docket without a status or dated movements', { reason: 'listed' });
  }
  const summaryEvent = events.find(event => event.description?.toLowerCase() === summary.toLowerCase());
  return {
    status: current ? languageStageStatus(current) : 'unknown',
    ...(current && { current_stage: current, current_stage_source: 'carrier_map' }),
    ...(summary && !hasPrivateDeliveryDetails(summary) && { last_status_text: summary }),
    ...(summaryEvent && { last_update_local: summaryEvent.local_time }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'flashpy';

function localTime(value: string): string | undefined {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return undefined;
  const date = DateTime.fromSQL(text, { zone: 'utc' });
  return date.isValid ? date.toFormat("yyyy-MM-dd'T'HH:mm") : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  if (!$('#trackForm input[name="code"]').length) throw new SchemaError(provider, 'Flashpy did not return its guest tracker');
  const card = $('#resultWrap');
  const identity = clean(card.find('#r-id').text()).toUpperCase();
  if (identity !== number) throw new IndeterminateError(provider, 'Flashpy did not return the requested tracking reference');

  const summary = clean(card.find('#r-status').text());
  const currentStage = stages.get(summary.toLowerCase());
  const distinct = new Set<string>();
  const events: CarrierEvent[] = [];
  for (const row of card.find('#r-timeline li').toArray()) {
    const description = clean($(row).find('.font-medium').text());
    const date = localTime($(row).find('.opacity-70').text());
    if (!description || !date || hasPrivateDeliveryDetails(description)) continue;
    const key = date + '\x00' + description;
    if (distinct.has(key)) continue;
    distinct.add(key);
    const stage = stages.get(description.toLowerCase());
    events.push({ description, local_time: date, ...(stage && { stage, stage_source: 'carrier_map' }) });
  }
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  if (!events.length && !currentStage) {
    throw new IndeterminateError(provider, 'Flashpy returned the reference without a status or dated movements', { reason: 'listed' });
  }
  const summaryEvent = events.find(event => event.description?.toLowerCase() === summary.toLowerCase());
  return {
    status: currentStage ? languageStageStatus(currentStage) : 'unknown',
    ...(currentStage && { current_stage: currentStage, current_stage_source: 'carrier_map' }),
    ...(summary && !hasPrivateDeliveryDetails(summary) && { last_status_text: summary }),
    ...(summaryEvent && { last_update_local: summaryEvent.local_time }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}

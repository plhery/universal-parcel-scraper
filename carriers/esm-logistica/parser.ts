import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'esm-logistica';

const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const datePattern = /^(\d{1,2}) ([a-z]+) (\d{4})(?:\s+(\d{1,2}):(\d{2}) (am|pm))?$/i;

function localTime(value: string): string | undefined {
  const match = datePattern.exec(clean(value));
  if (!match) return undefined;
  const [, day, monthName, year, hour, minute, period] = match;
  const month = months.indexOf(monthName!.toLowerCase().slice(0, 3)) + 1;
  if (hour && (+hour < 1 || +hour > 12)) return undefined;
  const clockHour = hour ? (+hour % 12) + (period?.toLowerCase() === 'pm' ? 12 : 0) : 0;
  const date = DateTime.fromObject(
    { year: +year!, month, day: +day!, hour: clockHour, minute: minute ? +minute : 0 },
    { zone: 'utc' },
  );
  if (!date.isValid) return undefined;
  return hour ? date.toFormat("yyyy-MM-dd'T'HH:mm") : date.toISODate();
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'ESM Logística requires verification');
  }
  const $ = load(body);
  if (!$('#seguimientoForm #seguimientoGuia').length) {
    throw new SchemaError(provider, 'ESM Logística did not return its public tracker');
  }
  const guide = clean($('.tracking-result__guia-badge').text()).match(/^Guía #\s*(\d+)$/i)?.[1];
  if (!guide && $('#seguimientoGuia').attr('value') === number
    && /^No se encontraron datos para esta\b/i.test(clean($('.tracking-error').text()))) {
    throw new NotFoundError(provider);
  }
  if (guide !== number) {
    throw new IndeterminateError(provider, 'ESM Logística did not return the requested guide');
  }

  const summary = clean($('.tracking-result__estado').text());
  const stage = stages.get(summary.toLowerCase());
  const events: CarrierEvent[] = [];
  for (const row of $('.esm-timeline-item').toArray()) {
    const description = clean($(row).find('.esm-timeline-title').text());
    const date = $(row).find('.esm-timeline-date');
    const day = date.clone().children().remove().end().text();
    const local = localTime(clean(day) + ' ' + clean(date.find('small').text()));
    if (!local || !description || hasPrivateDeliveryDetails(description)) continue;
    const eventStage = stages.get(description.toLowerCase());
    events.push({
      description, local_time: local,
      ...(eventStage && { stage: eventStage, stage_source: 'carrier_map' }),
    });
  }
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  if (!events.length && !stage) {
    throw new IndeterminateError(provider, 'ESM Logística returned the guide without a status or dated events', { reason: 'listed' });
  }
  const summaryEvent = events.find(event => event.description?.toLowerCase() === summary.toLowerCase());
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    ...(summary && !hasPrivateDeliveryDetails(summary) && { last_status_text: summary }),
    ...(summaryEvent && { last_update_local: summaryEvent.local_time }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}

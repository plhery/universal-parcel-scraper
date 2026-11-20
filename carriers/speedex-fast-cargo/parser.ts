import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'speedex-fast-cargo';

function scanLocation(type: string, detail: string): string | undefined {
  const location = type === 'outscan'
    ? /^Outscan ([\p{L}][\p{L} .'-]{0,50}?) To [\p{L}][\p{L} .'-]{0,50}$/iu.exec(detail)?.[1]
    : type === 'inscan' ? /^Inscan ([\p{L}][\p{L} .'-]{0,50})$/iu.exec(detail)?.[1] : undefined;
  return location && !hasPrivateDeliveryDetails(location) ? location : undefined;
}

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  if (clean($('.header').first().text()) !== 'Booking Tracking Details') {
    throw new SchemaError(provider, 'Speedex Fast Cargo did not return its tracking page');
  }
  const panel = $('.form-section').first();
  if (/^Consignment details not found for this Airway Bill \/ ID!$/i.test(clean(panel.text()))) {
    throw new NotFoundError(provider);
  }
  const fields = panel.find('.info-grid .info-group');
  const field = (label: string) => fields.filter((_, element) => clean($(element).find('label').text()) === label)
    .find('.info-val');
  if (clean(field('Airway Bill No. (AWB No.)').first().text()) !== number) {
    throw new IndeterminateError(provider, 'Speedex Fast Cargo did not return the requested docket');
  }

  const events = new Map<string, CarrierEvent & { stage?: Stage }>();
  for (const row of panel.find('.track-table tbody tr').toArray().reverse()) {
    const cells = $(row).children('td');
    const rawDate = clean(cells.eq(0).text());
    const date = DateTime.fromFormat(rawDate, 'dd-MM-yyyy', { zone: 'utc' });
    const description = clean(cells.eq(1).text());
    if (!date.isValid || !description || hasPrivateDeliveryDetails(description)) continue;
    const localTime = date.toISODate();
    const type = description.toLowerCase();
    const stage = stages.get(type);
    const location = scanLocation(type, clean(cells.eq(2).text()));
    events.set(JSON.stringify([localTime, type, location]), {
      local_time: localTime, description, ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }
  const history = [...events.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const latest = history[0];
  const status = clean(field('Current Status').last().text());
  const safeStatus = status && !hasPrivateDeliveryDetails(status) ? status : '';
  const summary = stages.get(safeStatus.toLowerCase());
  const current = summary ?? latest?.stage;
  const statusEvent = summary ? history.find(event => event.stage === summary) : latest;
  const lastStatusText = safeStatus || latest?.description;
  if (!latest && !safeStatus) {
    throw new IndeterminateError(provider, 'Speedex Fast Cargo listed the docket without a status or dated movements', { reason: 'listed' });
  }
  return {
    status: current ? languageStageStatus(current) : 'unknown',
    ...(current && { current_stage: current, current_stage_source: 'carrier_map' }),
    ...(lastStatusText && { last_status_text: lastStatusText }),
    ...(statusEvent && { last_update_local: statusEvent.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}

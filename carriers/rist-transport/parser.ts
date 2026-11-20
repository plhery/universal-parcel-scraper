import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { administrativeUpdates, stages } from './status.js';

export const provider = 'rist-transport';

function localTimestamp(dateText: string, timeText: string): string | undefined {
  const date = DateTime.fromFormat(dateText, 'M/d/yyyy', { zone: 'UTC' });
  if (!date.isValid) return undefined;
  if (!timeText) return date.toISODate();

  // The portal uses zero on some AM clocks alongside the usual 1–12 notation.
  const clock = timeText.replace(/^00:(\d{2} AM)$/, '12:$1');
  const time = DateTime.fromFormat(dateText + ' ' + clock, 'M/d/yyyy h:mm a', { locale: 'en-US', zone: 'UTC' });
  return time.isValid ? time.toFormat("yyyy-MM-dd'T'HH:mm:ss") : date.toISODate();
}

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  const title = clean($('title').first().text());
  if (title === 'RIST - Shipment Tracking - Powered by Carrier Logistics' && $('#shipmenttracking').length) {
    throw new NotFoundError(provider);
  }
  if (title !== 'RIST - Shipment Details - Powered by Carrier Logistics') {
    throw new SchemaError(provider, 'RIST Transport did not return a shipment detail page');
  }
  const field = (label: string) => clean($('th').filter((_, element) => clean($(element).text()) === label)
    .first().next('td').text());
  const identity = /^(\d+)(?:\s+-\s+\S+)?$/.exec(field('Shipment Number:'))?.[1];
  if (identity !== number) throw new IndeterminateError(provider, 'RIST Transport did not return the requested PRO');

  const movements = new Map<string, CarrierEvent & { stage?: Stage }>();
  const rows = $('table.newtables2').filter((_, table) => clean($(table).find('th').first().text()) === 'Shipment Status')
    .find('tr');
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    const carrierText = clean(cells.eq(0).text());
    const description = /^DELIVERED; THANK YOU FOR USING\b/i.test(carrierText) ? 'Delivered' : carrierText;
    const stage = stages.get(description);
    if (!stage && !administrativeUpdates.has(description)) continue;
    const localTime = localTimestamp(clean(cells.eq(2).text()), clean(cells.eq(3).text()));
    if (!localTime) continue;
    const detail = clean(cells.eq(1).text());
    const location = /^[\p{L} .'-]{2,45}, [A-Z]{2}$/u.test(detail) && !hasPrivateDeliveryDetails(detail) ? detail : '';
    movements.set(JSON.stringify([localTime, description, location.toLowerCase()]), {
      local_time: localTime, description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }
  const history = [...movements.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const summaryText = field('Status:');
  const summary = stages.get(summaryText);
  const latest = history.find(event => event.stage);
  const stage = summary ?? latest?.stage;
  if (!stage && !history.length) {
    throw new IndeterminateError(provider, 'RIST Transport listed the PRO without usable tracking details', { reason: 'listed' });
  }
  const statusEvent = summary ? history.find(event => event.stage === summary) : latest ?? history[0];
  const stamp = statusEvent?.local_time ?? (summary === 'delivered' ? localTimestamp(field('Delivered Date:'), '') : undefined);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: summary ? summaryText : statusEvent?.description,
    ...(stamp && { last_update_local: stamp }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}

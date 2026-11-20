import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'exfreight';

type Movement = { event: CarrierEvent & { stage: Stage }; sortTime: number };

function movement(description: string, rawDate: string, zoneLabel: string): Movement | undefined {
  const stage = stages.get(description);
  if (!stage) return undefined;
  const format = 'ccc LLL d yyyy h:mm a';
  const parsed = DateTime.fromFormat(rawDate, format, { locale: 'en-US', zone: 'UTC' });
  if (!parsed.isValid) return undefined;

  const base = { description, stage, stage_source: 'carrier_map' };
  // Most carrier rows have a midnight placeholder. Keep those at calendar-date precision.
  if (parsed.hour === 0 && parsed.minute === 0) {
    return { event: { ...base, local_time: parsed.toISODate() }, sortTime: parsed.toMillis() };
  }
  const zone = /^Time Zone: (\S+)$/.exec(zoneLabel)?.[1];
  const zoned = zone && firstOccurrence(DateTime.fromFormat(rawDate, format, { locale: 'en-US', zone }));
  if (zoned && zoned.isValid) {
    return { event: { ...base, time: zoned.toISO({ suppressMilliseconds: true }) }, sortTime: zoned.toMillis() };
  }
  return {
    event: { ...base, local_time: parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss") },
    sortTime: parsed.toMillis(),
  };
}

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  if (clean($('title').first().text()) !== 'Exfresso Shipment Tracking'
    || !$('form[action="/track"] input[name="bol"]').length) {
    throw new SchemaError(provider, 'ExFreight did not return its public tracking page');
  }
  const shipments = $('.shipment-list-row');
  if (!shipments.length) throw new NotFoundError(provider);
  const identity = clean(shipments.find('span.table-medium').first().text());
  const returned = /^(?:[A-Z0-9]+-)?(\d{10})$/i.exec(identity)?.[1];
  if (shipments.length !== 1 || returned !== number) {
    throw new IndeterminateError(provider, 'ExFreight returned a different shipment');
  }

  const movements = new Map<string, Movement>();
  for (const marker of $('.row > .stu-updates').toArray()) {
    const cells = $(marker).parent().children();
    const date = cells.eq(2);
    const scan = movement(clean(cells.eq(1).text()), clean(date.text()), date.attr('title') ?? '');
    if (scan) movements.set(JSON.stringify(scan.event), scan);
  }
  const history = [...movements.values()].reverse().sort((a, b) => b.sortTime - a.sortTime)
    .map(scan => scan.event);
  const carrierText = clean(shipments.find('.timeliness .date-caption').first().text());
  const summary = stages.get(carrierText);
  const latest = history[0];
  const stage = summary ?? latest?.stage;
  if (!stage) {
    throw new IndeterminateError(provider, 'ExFreight listed the shipment without a usable status', { reason: 'listed' });
  }

  const statusEvent = summary ? history.find(event => event.stage === summary) : latest;
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: 'carrier_map',
    last_status_text: summary ? carrierText : latest?.description,
    ...(statusEvent?.time && { last_update: statusEvent.time }),
    ...(statusEvent?.local_time && { last_update_local: statusEvent.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}

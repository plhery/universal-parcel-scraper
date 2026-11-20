import { load, type Cheerio } from 'cheerio';
import { isText, type AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'sun-logistics';

function cellLines(cell: Cheerio<AnyNode>): string[] {
  return cell.contents().toArray().filter(isText).map(node => clean(node.data)).filter(Boolean);
}

export function parseTracking(body: string, number: string): CarrierResult {
  const $ = load(body);
  if (!clean($('title').first().text()).endsWith('Sun Logistics - Track a Shipment - Powered by Carrier Logistics')) {
    throw new SchemaError(provider, 'Sun Logistics did not return its shipment tracker');
  }
  const heading = clean($('.pagetitletext').first().text());
  if (heading === 'Shipment Tracking' && !$('#collapseTwo table').length) throw new NotFoundError(provider);
  if (/^Shipment number (\S+)$/i.exec(heading)?.[1]?.toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'Sun Logistics did not return the requested PRO');
  }

  const movements = new Map<string, CarrierEvent & { stage?: Stage }>();
  for (const row of $('#collapseTwo table tr').toArray()) {
    const cells = $(row).children('td');
    const [date, time] = cellLines(cells.eq(0));
    const [wording, detail] = cellLines(cells.eq(1));
    if (!date || !time || !wording) continue;
    const scan = DateTime.fromFormat(date + ' ' + time.toUpperCase(), 'M/d/yy h:mma', { locale: 'en-US', zone: 'utc' });
    if (!scan.isValid) continue;
    const stage = stages.get(wording);
    const appointment = wording.startsWith('Appointment Set:');
    if (!stage && !appointment) continue;

    const description = appointment ? 'Appointment Set' : wording;
    const location = detail?.replace(/^Sun Logistics\s+/i, '');
    const cityState = location && /^[\p{L} .'-]{2,45}, [A-Z]{2}$/u.test(location) && !hasPrivateDeliveryDetails(location)
      ? location : undefined;
    const localTime = scan.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    movements.set(JSON.stringify([localTime, description, cityState]), {
      local_time: localTime,
      description,
      ...(cityState && { location: cityState }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }
  const history = [...movements.values()].sort((a, b) => (b.local_time ?? '').localeCompare(a.local_time ?? ''));
  const summaryText = clean($('.card-body h4.mt-3').first().text());
  const summary = stages.get(summaryText);
  const latest = history.find(event => event.stage);
  const stage = summary ?? latest?.stage;
  if (!stage && !history.length) {
    throw new IndeterminateError(provider, 'Sun Logistics listed the PRO without usable tracking details', { reason: 'listed' });
  }
  const statusEvent = summary ? history.find(event => event.stage === summary) : latest ?? history[0];
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: summary ? summaryText : statusEvent?.description,
    ...(statusEvent && { last_update_local: statusEvent.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}

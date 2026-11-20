import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { confirmedMovement, movementStages } from './status.js';

export const provider = 'don-mariano-express';

const hub = /^(?:(?:C[oó]rdoba|Garup[aá]|Posadas|Corrientes|Rosario|Buenos Aires|Barracas|Virasoro)(?: Capital| Centro)?(?: RM)?|Resis?tencia Centro Chaco)$/i;

export function parseTracking(body: string, number: string, guide: boolean): CarrierResult {
  const $ = load(body);
  const heading = $('h1').filter((_, element) => /^DETALLE DE GUÍA #\d+$/.test(clean($(element).text()))).first();
  const result = heading.parents().filter((_, element) => $(element).find('h3').length > 0).first();
  const code = result.find('span').filter((_, element) => clean($(element).text()) === 'Cod seguimiento:')
    .first().next('span');
  const identity = guide ? clean(heading.text()).match(/\d+$/)?.[0] : clean(code.text());
  if (!identity || identity !== number) {
    throw new IndeterminateError(provider, 'Don Mariano Express did not return the requested guide or tracking code');
  }

  const status = clean(heading.parent().parent().find('span.text-xs.font-semibold').first().text());
  const summary = status && !hasPrivateDeliveryDetails(status) ? status : '';
  const panel = result.find('h3').filter((_, element) =>
    /^Movimientos(?:\s*\d+)?$/.test(clean($(element).text())),
  ).first().parent();

  const events: CarrierEvent[] = [];
  for (const element of panel.find('p.text-xs.font-bold').toArray()) {
    const label = clean($(element).text());
    const stage = movementStages.get(label);
    const card = $(element).parent();
    if (!stage || clean(card.children('span').text()) !== confirmedMovement) continue;
    const parts = card.children('p');
    const clock = clean(parts.eq(2).text());
    const day = /^([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})(?:,|$)/.exec(clock)?.[1];
    if (!day) continue;
    const parsed = DateTime.fromFormat(day, 'd/M/yyyy', { zone: 'utc' });
    if (!parsed.isValid) continue;
    const location = clean(parts.eq(1).text());
    events.push({
      local_time: parsed.toISODate(), description: label.replace(/^●\s*/u, ''), stage, stage_source: 'carrier_map',
      ...(hub.test(location) && { location }),
    });
  }

  events.sort((left, right) => (right.local_time ?? '').localeCompare(left.local_time ?? ''));
  const latest = events[0];
  if (!latest && !summary) {
    throw new IndeterminateError(provider, 'Don Mariano Express listed the guide without confirmed movements', { reason: 'listed' });
  }
  return {
    status: latest ? 'in_transit' : 'unknown',
    ...(latest ? {
      current_stage: 'in_transit', current_stage_source: 'carrier_map', last_update_local: latest.local_time, events,
    } : { summary_only: true }),
    ...(summary && { last_status_text: summary }),
  };
}

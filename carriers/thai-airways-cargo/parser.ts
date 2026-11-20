import type { CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { stages } from './status.js';

export const provider = 'thai-airways-cargo';
type Movement = CarrierEvent & { local_time: string; stage: Stage };

export function parseTracking(page: CheerioAPI, waybill: string): CarrierResult {
  const summary = page('#trackShiptable1row00').children('td');
  if (summary.eq(1).text().trim() !== waybill) {
    throw new IndeterminateError(provider, 'THAI Cargo did not confirm the requested waybill');
  }
  const destination = summary.eq(3).text().trim();
  const total = Number(summary.eq(4).text().trim());
  const detail = page('#trackShiptable1rowInner0 table.grdTable');
  const headings = detail.find('th').map((_, cell) => page(cell).text().trim()).get();
  if (!['Station', 'Status Date', 'Status', 'Pieces'].every(label => headings.includes(label))) {
    throw new SchemaError(provider, 'THAI Cargo omitted the movement table headings');
  }

  const events: Movement[] = [];
  const seen = new Set<string>();
  let deliveredPieces = 0;
  // The carrier lists movements newest first, using each station's local clock.
  for (const row of detail.find('tr.grdRow').toArray().reverse()) {
    const cells = page(row).children('td');
    const read = (label: string) => cells.eq(headings.indexOf(label)).text().trim();
    const location = read('Station');
    const description = read('Status');
    const date = DateTime.fromFormat(read('Status Date'), 'dd MMM yyyy HH:mm', { locale: 'en', zone: 'UTC' });
    let stage = stages.get(description.toLowerCase());
    if (!date.isValid || !stage) continue;
    const local_time = date.toFormat("yyyy-MM-dd'T'HH:mm");
    const pieces = Number(read('Pieces'));
    const key = JSON.stringify([location, local_time, description, pieces]);
    if (seen.has(key)) continue;
    seen.add(key);

    if (stage === 'delivered') {
      if (location === destination && Number.isSafeInteger(pieces) && pieces > 0) deliveredPieces += pieces;
      if (!Number.isSafeInteger(total) || total <= 0 || deliveredPieces < total) stage = 'in_transit';
    }
    events.push({
      local_time, description, ...(/^[A-Z]{3}$/.test(location) && { location }), stage, stage_source: 'carrier_map',
    });
  }
  events.reverse();
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'THAI Cargo listed the waybill without dated movements', { reason: 'listed' });
  return {
    status: languageStageStatus(latest.stage), current_stage: latest.stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

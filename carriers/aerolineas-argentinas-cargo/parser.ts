import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'aerolineas-argentinas-cargo';
type Movement = CarrierEvent & { local_time: string; stage?: Stage };

const grids = [
  { id: '#gvBkAcInfo', description: 0, station: 1, stamp: 6 },
  { id: '#GridViewAwbTracking', description: 1, station: 0, stamp: 5 },
];

export function parseTracking(html: string, serial: string): CarrierResult {
  const page = load(html);
  if (!page('#FrmAWBTracking').length) {
    throw new SchemaError(provider, 'Aerolíneas Argentinas Cargo did not return its tracking page');
  }
  const awb = clean(page('#lblAWBNo').text()).replace(/[\s-]/g, '');
  if (awb !== '044' + serial) {
    throw new IndeterminateError(provider, 'Aerolíneas Argentinas Cargo did not confirm the requested air waybill');
  }

  const movements = new Map<string, Movement>();
  for (const grid of grids) {
    for (const row of page(grid.id).find('tr').toArray()) {
      const cells = page(row).children('td');
      if (cells.length <= grid.stamp) continue;
      const description = clean(cells.eq(grid.description).text());
      if (!description || hasPrivateDeliveryDetails(description) || /^(?:planned|scheduled|expected|estimated)\b/i.test(description)) continue;
      const stamp = DateTime.fromFormat(clean(cells.eq(grid.stamp).text()), 'dd/MM/yyyy HH:mm', { zone: 'UTC' });
      if (!stamp.isValid) continue;

      const station = clean(cells.eq(grid.station).text());
      const location = /^[A-Z]{3}$/.test(station) ? station : undefined;
      const clock = stamp.toFormat("yyyy-MM-dd'T'HH:mm");
      const stage = stages.get(description.toLowerCase());
      movements.set(JSON.stringify([clock, description, location]), {
        local_time: clock, description,
        ...(location && { location }),
        ...(stage && { stage, stage_source: 'carrier_map' }),
      });
    }
  }
  const history = [...movements.values()].sort((a, b) => b.local_time.localeCompare(a.local_time));
  const latest = history[0];
  const summary = clean(page('#pnlMultipleAWBs [id$="_lblLatestActivity"]').first().text());
  const wording = summary && !hasPrivateDeliveryDetails(summary) ? summary : '';
  const summaryStage = stages.get(wording.replace(/\s+at\s+[A-Z]{3}$/i, '').toLowerCase());
  const stage = summaryStage ?? latest?.stage;
  if (!wording && !latest) {
    throw new IndeterminateError(provider, 'Aerolíneas Argentinas Cargo listed the air waybill without a status', { reason: 'listed' });
  }
  const lastMove = wording
    ? (summaryStage ? history.find(event => event.stage === summaryStage) : undefined) : latest;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: wording || latest?.description,
    ...(lastMove && { last_update_local: lastMove.local_time }),
    ...(history.length ? { events: history } : { summary_only: true }),
  };
}

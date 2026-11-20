import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { stages } from './status.js';

export const provider = 'volaris-cargo';

export function parseTracking(html: string, number: string): CarrierResult {
  const page = load(html);
  if (!page('#aspnetForm [id$="_TextBoxAWBno"]').length) {
    throw new SchemaError(provider, 'Volaris Cargo did not return its tracking page');
  }
  const heading = clean(page('#contentarea_tracking [id$="_lblAWBNo"]').text());
  if (heading.replace(/[\s-]/g, '') !== number) {
    throw new IndeterminateError(provider, 'Volaris Cargo did not confirm the requested air waybill');
  }

  const events: (CarrierEvent & { local_time: string; stage?: Stage })[] = [];
  for (const row of page('[id$="_GridViewAwbTracking"] tr').toArray()) {
    const cells = page(row).children('td');
    if (cells.length < 6) continue;
    const description = clean(cells.eq(1).text());
    if (!description || hasPrivateDeliveryDetails(description) || /^(?:planned|scheduled|expected|estimated)\b/i.test(description)) continue;
    const stamp = DateTime.fromFormat(clean(cells.eq(5).text()), 'dd/MM/yyyy HH:mm', { zone: 'UTC' });
    if (!stamp.isValid) continue;
    const station = clean(cells.eq(0).text());
    const stage = stages.get(description.toLowerCase());
    events.push({
      local_time: stamp.toFormat("yyyy-MM-dd'T'HH:mm"),
      description,
      ...(/^[A-Z]{3}$/.test(station) && { location: station }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    });
  }

  events.reverse();
  events.sort((a, b) => b.local_time.localeCompare(a.local_time));
  const latest = events[0];
  const summary = clean(page('[id$="_pnlMultipleAWBs"] [id$="_lblLatestActivity"]').first().text());
  const summaryStage = stages.get(summary.replace(/\s+at\s+[A-Z]{3}$/i, '').toLowerCase());
  if (!latest && !summaryStage) {
    throw new IndeterminateError(provider, 'Volaris Cargo listed the air waybill without a status', { reason: 'listed' });
  }

  const stage = summaryStage ?? latest?.stage;
  const currentMovement = summaryStage ? events.find(event => event.stage === summaryStage) : latest;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: summaryStage ? summary : latest?.description,
    ...(currentMovement && { last_update_local: currentMovement.local_time }),
    ...(events.length ? { events } : { summary_only: true }),
  };
}

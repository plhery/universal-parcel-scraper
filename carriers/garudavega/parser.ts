import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { garudavegaStage } from './status.js';

export const PROVIDER = 'Garudavega';
// The arrival date the shipment is expected on, dated when it was written: a forecast, not a scan.
const FORECAST = /^expected arrival\b/i;

export function parseReply(body: string, number: string): CarrierResult {
  const $ = load(body);
  const missing = $('.track-error-box.is-notfound');
  if (missing.find('.state-badge').text().trim() === 'Not found' && missing.find('h4').text().trim() === number) throw new NotFoundError(PROVIDER);
  if ($('.track-id').text().trim() !== `Your Shipment: ${number}`) throw new IndeterminateError(PROVIDER, 'Missing matching shipment heading');
  const events: CarrierEvent[] = [];
  const stages: (ClassifiedWording | null)[] = [];
  const seen = new Set<string>();
  for (const block of $('.timeline .time-content').toArray()) {
    const day = $(block).children('h5').text().trim();
    for (const row of $(block).find('.delivery_details > li').toArray()) {
      const description = $(row).children('p').text().trim();
      const location = $(row).children('h6').text().trim();
      const clock = $(row).children('small').text().trim();
      const local = DateTime.fromFormat(`${day} ${clock}`, 'dd MMMM yyyy hh:mm a', { locale: 'en', zone: 'UTC' });
      if (!description || !local.isValid) throw new SchemaError(PROVIDER, 'Invalid dated scan');
      if (FORECAST.test(description)) continue;
      // Each piece of a shipment repeats the same scan.
      const key = JSON.stringify([local.toMillis(), description, location]);
      if (seen.has(key)) continue;
      seen.add(key);
      const stage = garudavegaStage(description);
      stages.push(stage);
      events.push({ local_time: local.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description, ...(location ? { location } : {}),
        ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) });
    }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const latest = events[0]!;
  const stage = stages[0];
  return { status: stage ? languageStageStatus(stage.stage) : 'unknown',
    ...(stage ? { current_stage: stage.stage, current_stage_source: stage.source } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time, expected_delivery: null, events };
}

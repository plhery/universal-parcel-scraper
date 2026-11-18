import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';

export const PROVIDER = 'Garudavega';
const stages = new Map<string, Stage>([
  ['OK DELIVERY', 'delivered'], ['SHIPMENT RECEIVED', 'accepted'], ['Open Manifest Arrived Hub', 'in_transit'],
]);

export function parseReply(body: string, number: string): CarrierResult {
  const $ = load(body);
  const missing = $('.track-error-box.is-notfound');
  if (missing.find('.state-badge').text().trim() === 'Not found' && missing.find('h4').text().trim() === number) throw new NotFoundError(PROVIDER);
  if ($('.track-id').text().trim() !== `Your Shipment: ${number}`) throw new IndeterminateError(PROVIDER, 'Missing matching shipment heading');
  const events: CarrierEvent[] = [];
  for (const block of $('.timeline .time-content').toArray()) {
    const day = $(block).children('h5').text().trim();
    for (const row of $(block).find('.delivery_details > li').toArray()) {
      const description = $(row).children('p').text().trim();
      const location = $(row).children('h6').text().trim();
      const clock = $(row).children('small').text().trim();
      const local = DateTime.fromFormat(`${day} ${clock}`, 'dd MMMM yyyy hh:mm a', { locale: 'en', zone: 'UTC' });
      if (!description || !local.isValid) throw new SchemaError(PROVIDER, 'Invalid dated scan');
      const stage = stages.get(description);
      events.push({ local_time: local.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description, ...(location ? { location } : {}),
        ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
    }
  }
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const latest = events[0]!, stage = latest.stage as Stage | undefined;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time, expected_delivery: null, events };
}

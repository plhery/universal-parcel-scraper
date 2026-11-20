import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { scanStage } from './status.js';

export const provider = 'united-africa-feeder-line';

export function parseTracking(body: string, booking: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'UAFL requires verification');
  }
  const $ = load(body);
  const results = $('#results');
  if (results.length !== 1) throw new SchemaError(provider, 'UAFL did not return a booking result');
  if (/^No tracking information found for the booking number\.?$/i.test(results.text().trim())) {
    throw new NotFoundError(provider);
  }

  const labels = new Map(results.find('p').toArray().map(row => [
    $(row).find('strong').text().trim(),
    $(row).find('span').text().trim(),
  ]));
  if (!labels.get('Booking No:')) throw new SchemaError(provider, 'UAFL omitted the booking number');
  if (labels.get('Booking No:')?.toUpperCase() !== booking) {
    throw new IndeterminateError(provider, 'UAFL returned a different booking number');
  }

  const containers = new Set(labels.get('Booked Containers:')?.toUpperCase().match(/[A-Z]{4}\d{7}/g) ?? []);
  const events = results.find('.table-responsive:has(h5 strong)').toArray().flatMap(section => {
    if (!containers.has($(section).find('h5 strong').text().trim().toUpperCase())) {
      throw new SchemaError(provider, 'UAFL listed a movement table for equipment outside the booking');
    }
    return $(section).find('table tbody tr').toArray().map(row => {
      const cells = $(row).children('td');
      const description = cells.eq(0).text().trim();
      const clock = cells.eq(1).text().trim();
      const location = cells.eq(3).text().trim() || cells.eq(2).text().trim();
      if (!description || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(clock)
          || !DateTime.fromSQL(clock, { zone: 'utc' }).isValid) {
        throw new SchemaError(provider, 'UAFL returned a malformed movement row');
      }
      const stage = scanStage(description);
      return {
        local_time: clock.replace(' ', 'T').replace(/\.0+$/, ''),
        description,
        ...(location && { location }),
        ...(stage && { stage, stage_source: 'carrier_map' }),
      };
    });
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'UAFL listed the booking without dated container movements', { reason: 'listed' });
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage && { current_stage: latest.stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description,
    last_update_local: latest.local_time,
    events,
  };
}

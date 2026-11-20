import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'sinokor-merchant-marine';

function checkChallenge(body: string): void {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Sinokor requires verification');
  }
}

export function assertKnownBooking(body: string): void {
  checkChallenge(body);
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'Sinokor did not return a booking check');
  }
  if (!isRecord(reply)) throw new SchemaError(provider, 'Sinokor changed its booking check');
  if (reply.STATUS === 'N' && reply.MSG === "Can't find Booking that you input.") throw new NotFoundError(provider);
  if (reply.STATUS !== 'Y' || reply.MSG !== '') throw new SchemaError(provider, 'Sinokor did not confirm the booking');
}

export function parseTracking(body: string, number: string): CarrierResult {
  checkChallenge(body);
  const $ = load(body);
  const booking = $('input#blno');
  if (booking.length !== 1) throw new SchemaError(provider, 'Sinokor omitted the booking field');
  if (booking.attr('value') !== number) throw new IndeterminateError(provider, 'Sinokor answered for a different booking');

  const table = $('table#tblResult');
  if (table.length !== 1) throw new IndeterminateError(provider, 'Sinokor listed the booking without a tracking table', { reason: 'listed' });
  const columns = table.find('thead th').map((_, node) => $(node).text().trim()).get();
  if (columns.join('|') !== 'Event|Container No. or Vessel/Voyage|Location|Date&Time') {
    throw new SchemaError(provider, 'Sinokor changed its tracking table');
  }
  const events = table.find('tbody > tr').toArray().flatMap(node => {
    const cells = $(node).children('td');
    const description = cells.eq(0).text().trim();
    const related = cells.eq(1).text().trim();
    const location = cells.eq(2).text().trim();
    const clock = cells.eq(3).text().trim();
    if (cells.length !== 4 || !description) throw new SchemaError(provider, 'Sinokor returned an invalid tracking row');
    if (description === 'Sea Way Bill' && related !== number) {
      throw new IndeterminateError(provider, 'Sinokor returned a movement table for a different bill');
    }
    if (description.endsWith(' (Scheduled)') || !clock) return [];
    const parts = /^(\d{4}-\d{2}-\d{2}) [A-Z]{3} (\d{2}:\d{2})$/.exec(clock);
    const local = parts && `${parts[1]}T${parts[2]}`;
    if (!local || !DateTime.fromISO(local, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'Sinokor returned an invalid event clock');
    }
    const stage = scanStage(description);
    return [{
      local_time: local, description, ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    }];
  }).reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Sinokor listed the booking without actual movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

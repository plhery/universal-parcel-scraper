import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'pacific-international-lines';

function readReply(body: string) {
  if (/cf-chl|_Incapsula_Resource|Request Rejected\. Your support ID|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'PIL requires verification');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    throw new SchemaError(provider, 'PIL did not return tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(provider, 'PIL changed its tracking reply');
  return reply;
}

export function parseFormState(body: string): string {
  const reply = readReply(body);
  if (reply.success !== true || typeof reply.n !== 'string' || !reply.n || reply.n.length > 256) {
    throw new SchemaError(provider, 'PIL omitted its guest form state');
  }
  return reply.n;
}

export function parseTracking(body: string, container: string): CarrierResult {
  const reply = readReply(body);
  if (typeof reply.data !== 'string') throw new SchemaError(provider, 'PIL omitted the tracking page fragment');
  const $ = load(reply.data);
  if (reply.error === true && $('body').text().trim() === `No data found for Container Number ${container}.`) {
    throw new NotFoundError(provider);
  }
  if (reply.success !== true) throw new SchemaError(provider, 'PIL did not return a successful tracking reply');

  const headings = $('table.table > thead td').filter((_, node) => /^Container # /.test($(node).text().trim().replace(/\s+/g, ' ')));
  if (headings.length !== 1) throw new SchemaError(provider, 'PIL omitted the container history heading');
  if (headings.text().trim().replace(/\s+/g, ' ') !== `Container # ${container}`) {
    throw new IndeterminateError(provider, 'PIL answered for a different container');
  }
  const rows = headings.closest('table').children('tbody').children('tr');
  const columns = rows.first().children('td').map((_, node) => $(node).text().trim()).get();
  if (columns.join('|') !== 'Vessel|Voyage|Event Date|Event Name|Event Place') {
    throw new SchemaError(provider, 'PIL changed its container movement columns');
  }

  const events = rows.slice(1).toArray().map(node => {
    const cells = $(node).children('td');
    const clock = cells.eq(2).text().trim();
    const date = DateTime.fromFormat(clock, 'dd-MMM-yyyy HH:mm:ss', { locale: 'en', zone: 'utc' });
    const description = cells.eq(3).text().trim();
    const location = cells.eq(4).text().trim();
    if (cells.length !== columns.length || !/^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}$/.test(clock)
        || !date.isValid || !description) {
      throw new SchemaError(provider, 'PIL returned an invalid container movement');
    }
    const localTime = date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const stage = scanStage(description);
    return {
      local_time: localTime, description, ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'PIL listed the container without movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

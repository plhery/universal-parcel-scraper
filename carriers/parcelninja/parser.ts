import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { parcelninjaStage } from './status.js';

const carrier = 'parcelninja';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Parcelninja returned a browser check');
  }

  const $ = load(html);
  const tracker = $('.tracking-details-conatiner');
  if (clean($('title').text()) !== 'ParcelNinja' || tracker.length !== 1) {
    throw new SchemaError(carrier, 'Parcelninja changed its guest tracker');
  }
  const body = tracker.find('.tracking-body');
  const table = body.children('table.tracking');
  const guide = clean(tracker.find('h2').first().text());
  if (guide === "The Waybill Number wasn't found!" && table.length === 1 && !table.find('tr').length) {
    throw new NotFoundError(carrier);
  }
  if (guide !== `Waybill #${number}`) {
    throw new IndeterminateError(carrier, 'Parcelninja returned a different waybill');
  }

  const rows = table.children('tbody').children('tr');
  if (body.length !== 1 || table.length !== 1 || !rows.length || rows.length > 500) {
    throw new SchemaError(carrier, 'Parcelninja changed its scan history');
  }
  const events: CarrierEvent[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    if (cells.length === 1 && cells.attr('colspan') === '2' && /^Signed By:/i.test(clean(cells.text()))) continue;
    const stamp = clean(cells.eq(0).text(), 35);
    const description = clean(cells.eq(1).text(), 160);
    const date = DateTime.fromFormat(stamp, "yyyy-MM-dd '/' hh:mm:ss a", { zone: 'UTC', locale: 'en' });
    if (cells.length !== 2 || !date.isValid || !description) {
      throw new SchemaError(carrier, 'Parcelninja changed its scan fields');
    }
    const stage = parcelninjaStage(description);
    events.push({
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"), description,
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    });
  }
  events.sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const latest = events[0];
  if (!latest?.description) throw new SchemaError(carrier, 'Parcelninja omitted dated scans');
  const stage = parcelninjaStage(latest.description);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 && { history_truncated: true }),
  };
}

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { ewlStage } from './status.js';

const carrier = 'ewl-costa-rica';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'EWL returned a browser check');
  }
  const $ = load(html);
  const tables = $('table');
  const summary = tables.filter((_, table) => clean($(table).find('tr').first().children('th').first().text()) === 'Código');
  const timeline = tables.filter((_, table) => {
    const heads = $(table).find('tr').first().children('th');
    return clean(heads.eq(0).text()) === 'Fecha/Hora' && clean(heads.eq(1).text()) === 'Estatus';
  });
  if (summary.length !== 1 || timeline.length !== 1) throw new SchemaError(carrier, 'EWL changed its public tracking tables');

  const reference = clean(summary.find('tr').eq(1).children('td').first().text(), 80).toUpperCase();
  const rows = timeline.find('tr').filter((_, row) => $(row).children('td').length > 0);
  if (!reference && !rows.length && summary.find('td').toArray().every(cell => !clean($(cell).text()))) {
    throw new NotFoundError(carrier);
  }
  if (reference !== number) throw new IndeterminateError(carrier, 'EWL returned a different guide');
  if (rows.length > 500) throw new SchemaError(carrier, 'EWL returned too many tracking rows');

  const events: (CarrierEvent & { local_time: string; description: string; stage?: Stage })[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children('td');
    const stamp = clean(cells.eq(0).text(), 42);
    const description = clean(cells.eq(1).text(), 180);
    const date = DateTime.fromFormat(stamp, 'dd-MM-yyyy h:mm a', { locale: 'en-US', zone: 'UTC' });
    if (cells.length < 2 || !description || !date.isValid) {
      throw new SchemaError(carrier, 'EWL changed the wording or clock of a tracking event');
    }
    const stage = ewlStage(description);
    events.push({
      description, local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    });
  }
  events.reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(carrier, 'EWL returned no tracking milestones for the guide');
  return {
    status: latest.stage ? languageStageStatus(latest.stage) : 'unknown',
    ...(latest.stage && { current_stage: latest.stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, events: events.slice(0, 100), ...(events.length > 100 && { history_truncated: true }),
  };
}

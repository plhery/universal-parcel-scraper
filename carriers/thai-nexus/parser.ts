import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { thaiNexusStage } from './status.js';

const carrier = 'thai-nexus';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'Thai Nexus returned a browser check');
  }
  const $ = load(html);
  const alert = $('main [data-slot="alert"] [data-slot="alert-title"]');
  if (alert.length === 1 && clean(alert.text()) === 'Shipment not found') throw new NotFoundError(carrier);

  const summary = $('main [data-slot="card-header"]').has('[data-slot="badge"]');
  const reference = summary.find('[data-slot="card-title"]');
  const badge = summary.find('[data-slot="badge"]');
  const current = clean(badge.text(), 120);
  if (summary.length !== 1 || reference.length !== 1 || badge.length !== 1 || !current) {
    throw new SchemaError(carrier, 'Thai Nexus changed its tracking summary');
  }
  if (clean(reference.text()).toUpperCase() !== number) {
    throw new IndeterminateError(carrier, 'Thai Nexus returned a different reference');
  }
  const history = $('main [data-slot="card-title"]').filter((_, title) => clean($(title).text()) === 'Tracking history');
  const list = history.closest('[data-slot="card"]').children('[data-slot="card-content"]').children('ol');
  const rows = list.children('li');
  if (history.length !== 1 || list.length !== 1 || !rows.length || rows.length > 500) {
    throw new SchemaError(carrier, 'Thai Nexus changed its tracking history');
  }
  const events = rows.toArray().map((row): { event: CarrierEvent; timestamp: number } => {
    const item = $(row);
    const label = item.find('[data-slot="badge"]');
    const date = item.find('time[datetime]');
    const description = clean(label.text(), 120);
    const parsed = explicitOffsetTime(date.attr('datetime'));
    if (label.length !== 1 || date.length !== 1 || !description || !parsed) {
      throw new SchemaError(carrier, 'Thai Nexus changed its scan fields');
    }
    const stage = thaiNexusStage(description);
    return {
      event: {
        description, time: parsed.iso,
        ...(stage && { stage, stage_source: 'explicit_mapping' }),
      },
      timestamp: parsed.timestamp,
    };
  }).sort((left, right) => right.timestamp - left.timestamp);

  const stage = thaiNexusStage(current);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: current, last_update: events[0]!.event.time ?? null, expected_delivery: null,
    events: events.slice(0, 100).map(row => row.event),
    ...(events.length > 100 && { history_truncated: true }),
  };
}

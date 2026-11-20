import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { flowStage } from './status.js';

const carrier = 'flow-progressive-logistics';
const missing = 'Wrong AWB Number. Please put the correct FLOW AWB number';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'FLOW returned a browser check');
  }
  const $ = load(html);
  const tracker = $('#flow-tracking-content');
  const results = tracker.children('.order-tracking-output');
  if (tracker.length !== 1 || results.length !== 1) {
    throw new SchemaError(carrier, 'FLOW changed its tracking response');
  }
  if (clean(results.text()) === missing) throw new NotFoundError(carrier);

  const header = results.children('.tracking-header-card');
  const waybill = header.find('.tracking-number-main');
  if (header.length !== 1 || waybill.length !== 1) {
    throw new SchemaError(carrier, 'FLOW changed its waybill header');
  }
  if (clean(waybill.text()).toUpperCase() !== number) {
    throw new IndeterminateError(carrier, 'FLOW returned a different waybill');
  }

  const badge = header.find('.status-badge');
  const current = clean(badge.text(), 160);
  const timeline = results.find('.status-timeline-content');
  const rows = timeline.children('.status-card-item');
  if (badge.length !== 1 || !current || timeline.length !== 1 || !rows.length || rows.length > 500) {
    throw new SchemaError(carrier, 'FLOW changed its tracking history');
  }
  const events = rows.toArray().map((row): CarrierEvent => {
    const item = $(row).children('.status-card-header');
    const title = item.children('.status-card-title');
    const time = item.children('.status-card-time');
    const description = clean(title.text(), 160);
    const date = DateTime.fromFormat(clean(time.text(), 60), 'd MMM yyyy HH:mm', { locale: 'en', zone: 'UTC' });
    if (title.length !== 1 || time.length !== 1 || !description || !date.isValid) {
      throw new SchemaError(carrier, 'FLOW changed its scan fields');
    }
    const stage = flowStage(description);
    return {
      description, local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
  }).reverse().sort((left, right) => right.local_time!.localeCompare(left.local_time!));
  const stage = flowStage(current);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: current, last_update: null, last_update_local: events[0]!.local_time,
    expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 && { history_truncated: true }),
  };
}

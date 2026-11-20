import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fletesDelSurStage } from './status.js';

const carrier = 'fletes-del-sur';

export function parseTracking(text: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'PFS returned a browser check');
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    throw new SchemaError(carrier, 'PFS returned invalid tracking JSON');
  }
  if (!isRecord(reply)) throw new SchemaError(carrier, 'PFS changed its guest tracking response');
  if (reply.status === 'CAPTCHA') throw new ChallengeError(carrier, 'PFS requires CAPTCHA verification');
  if (reply.status === 'Error' && reply.cuerpo === 'No encontramos esa guía. Verifícala e intenta de nuevo.') {
    throw new NotFoundError(carrier);
  }
  if (reply.status !== 'OK' || typeof reply.cuerpo !== 'string') {
    throw new IndeterminateError(carrier, 'PFS did not return a guide result');
  }

  const $ = load(reply.cuerpo);
  const guideLabel = $('.col-md-4 > strong').filter((_, label) => clean($(label).text()) === 'Guía');
  if (guideLabel.length !== 1 || clean(guideLabel.parent().contents().filter((_, node) => node.nodeType === 3).text()) !== number) {
    throw new IndeterminateError(carrier, 'PFS returned a different guide');
  }
  const timeline = $('.timeline');
  const rows = timeline.children('.timeline-item');
  if (timeline.length !== 1 || !rows.length || rows.length > 500) {
    throw new SchemaError(carrier, 'PFS changed its scan history');
  }

  const events = rows.toArray().map((row): CarrierEvent => {
    const item = $(row);
    const label = item.find('.timeline-body h4.mb-1');
    const description = clean(label.text(), 160);
    const location = clean(label.next('.mb-2').contents().filter((_, node) => node.nodeType === 3).text(), 140);
    const stamp = clean(item.children('.timeline-time').text(), 70).replace(/^[^,]+,\s+/, '');
    const date = DateTime.fromFormat(stamp, "d 'de' MMMM 'de' yyyy HH:mm", { zone: 'UTC', locale: 'es-MX' });
    if (label.length !== 1 || !description || !date.isValid) {
      throw new SchemaError(carrier, 'PFS changed its scan fields');
    }
    const stage = fletesDelSurStage(description);
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"), description,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    };
  }).sort((left, right) => right.local_time!.localeCompare(left.local_time!));

  const latest = events[0]!;
  const stage = fletesDelSurStage(latest.description!);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, events: events.slice(0, 100),
    ...(events.length > 100 && { history_truncated: true }),
  };
}

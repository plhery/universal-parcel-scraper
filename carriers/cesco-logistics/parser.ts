import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { cescoStage } from './status.js';

const carrier = 'cesco-logistics';
const milestones = [
  ['booking', 'Order booking'],
  ['pickup', 'Order pickup'],
  ['outbound', 'To city destination'],
  ['received city destination', 'Received to city destination'],
  ['delivered', 'Order Delivered'],
] as const;

export function parseTracking(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(html.slice(0, 64_000))) {
    throw new ChallengeError(carrier, 'CESCO returned a browser check');
  }
  const $ = load(html);
  if ($('center > h2').toArray().some(node => clean($(node).text()) === 'AIRWAYBILL NOT FOUND')) {
    throw new NotFoundError(carrier);
  }
  const result = $('.hasil-tracking');
  const heading = result.find('h5').filter((_, node) => /^AIRWAYBILL\b/.test(clean($(node).text())));
  if (result.length !== 1 || heading.length !== 1 || heading.children('span').length !== 1) {
    throw new SchemaError(carrier, 'CESCO changed its air waybill summary');
  }
  if (clean(heading.children('span').text()) !== number) {
    throw new IndeterminateError(carrier, 'CESCO returned a different air waybill');
  }

  const steps = result.find('#progressbar > li');
  const rows = result.find('.icon-content');
  if (steps.length !== milestones.length || rows.length !== milestones.length) {
    throw new SchemaError(carrier, 'CESCO changed its tracking milestones');
  }
  const events: (CarrierEvent & { local_time: string; description: string; stage?: Stage })[] = [];
  for (const [index, [icon, description]] of milestones.entries()) {
    const row = rows.eq(index);
    if (row.find('img.icon-a').attr('alt') !== icon) {
      throw new SchemaError(carrier, 'CESCO changed the order of its tracking milestones');
    }
    if (!steps.eq(index).hasClass('active')) continue;
    const paragraph = row.find('p');
    paragraph.find('br').replaceWith(' ');
    const text = clean(paragraph.text());
    const stamp = / (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/.exec(text);
    if (paragraph.length !== 1 || !stamp?.[1] || text.slice(0, stamp.index) !== description) {
      throw new SchemaError(carrier, 'CESCO changed the wording or time of a completed milestone');
    }
    const date = DateTime.fromFormat(stamp[1], 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' });
    if (!date.isValid) throw new SchemaError(carrier, 'CESCO returned an invalid scan time');
    const stage = cescoStage(description);
    events.push({
      description, local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(stage && { stage, stage_source: 'explicit_mapping' }),
    });
  }
  events.reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(carrier, 'CESCO returned no completed milestones');
  const stage = latest.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'explicit_mapping' }),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, events,
  };
}

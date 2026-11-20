import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { scanStage } from './status.js';

export const provider = 'salam-pacific-indonesia-lines';

const readableText = (value: string) => value.trim().replace(/\s+/g, ' ');

export function parseTracking(body: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'SPIL requires verification');
  }
  const $ = load(body);
  const search = $('input#searchkotak');
  const results = search.closest('.setup-content');
  if (search.length !== 1 || results.length !== 1) throw new SchemaError(provider, 'SPIL omitted the tracking search');
  if (search.attr('value') !== number) throw new IndeterminateError(provider, 'SPIL answered for a different search');

  const reference = results.find('p').filter((_, node) =>
    readableText($(node).children('span').first().text()) === 'Container Number');
  const history = results.find('#contenthistid');
  const empty = results.find('#titlenoresultid');
  if (reference.length === 0 && history.length === 0 && empty.length === 1
      && readableText(empty.parent().text()) === `We could not find any results matching you search ${number}`) {
    throw new NotFoundError(provider);
  }
  if (reference.length !== 1 || history.length !== 1) throw new SchemaError(provider, 'SPIL omitted the single-container movement result');
  if (readableText(reference.children('span').eq(1).text()) !== number) {
    throw new IndeterminateError(provider, 'SPIL returned movements for a different container');
  }

  const events = history.find('.tracking-item .tracking-content').toArray().map(node => {
    const entry = $(node).children('span').first();
    const description = readableText(entry.children('b').text());
    const clock = /^- (\d{2}\/\d{2}\/\d{4} \d{2}:\d{2})$/.exec(readableText(entry.children('span').text()))?.[1];
    const date = clock && DateTime.fromFormat(clock, 'dd/MM/yyyy HH:mm', { zone: 'utc' });
    if (!description || !date || !date.isValid) throw new SchemaError(provider, 'SPIL returned an invalid movement entry');
    const stage = scanStage(description);
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm"),
      description,
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'SPIL listed the container without dated movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

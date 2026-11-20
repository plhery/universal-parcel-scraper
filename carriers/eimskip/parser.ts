import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { scanStage } from './status.js';

export const provider = 'eimskip';

const readableText = (value: string) => value.trim().replace(/\s+/g, ' ');

export function parseTracking(body: string, number: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Security Check|Access Denied)|_Incapsula_Resource|cf-challenge-running/i.test(body)) {
    throw new ChallengeError(provider, 'Eimskip requires verification');
  }

  const $ = load(body);
  const results = $('section.shipment-search .shipment-search__results');
  if (results.length !== 1) throw new SchemaError(provider, 'Eimskip omitted the shipment search results');

  const references = results.find('.port-display__center-info').filter((_, node) =>
    readableText($(node).find('.port-display__center-info-text').text()) === 'Shipment number');
  const reference = references.find('.port-display__center-info-value');
  if (reference.length === 0 && readableText(results.find('.nothingfound__title').text()) === 'No results found') {
    throw new NotFoundError(provider);
  }
  if (reference.length !== 1) throw new SchemaError(provider, 'Eimskip omitted the shipment number');
  if (readableText(reference.text()) !== number) throw new IndeterminateError(provider, 'Eimskip answered for a different shipment');

  const rows = results.find('.shipment-search__routes .shipment-search__route-item--done');
  const events = rows.toArray().map(node => {
    const row = $(node);
    const description = readableText(row.find('.shipment-search__route-item-title').text());
    const clock = readableText(row.find('.shipment-search__route-item-date').text());
    const date = DateTime.fromFormat(clock, 'dd.MM.yyyy HH:mm', { zone: 'utc' });
    if (!description || !/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(clock) || !date.isValid) {
      throw new SchemaError(provider, 'Eimskip returned an invalid completed shipment milestone');
    }
    const stage = scanStage(description);
    return {
      local_time: clock.endsWith(' 00:00') ? date.toFormat('yyyy-MM-dd') : date.toFormat("yyyy-MM-dd'T'HH:mm"), description,
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).reverse().sort((left, right) => right.local_time.localeCompare(left.local_time));
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Eimskip listed the shipment without dated movements', { reason: 'listed' });

  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { stageForWording } from './status.js';

export const provider = 'gbs-broker';

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const cargo = $('.cargo.wrapper__page');
  if (cargo.length !== 1) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
      throw new ChallengeError(provider, 'GBS requires verification');
    }
    throw new SchemaError(provider, 'Missing GBS tracking results');
  }
  const cards = cargo.find('.cargo__wrapper');
  if (!cards.length && $('#parcel-track-number').val() === number &&
    cargo.children('p').text().trim() === 'По вашему запросу ничего не найдено') {
    throw new NotFoundError(provider);
  }
  const card = cards.filter((_, element) => $(element).find('.cargo__info')
    .filter((_, info) => $(info).find('.cargo__info-name').text().trim() === 'Номер:')
    .find('.cargo__info-text').text().trim().toUpperCase() === number);
  if (card.length !== 1) throw new IndeterminateError(provider, 'GBS could not identify one matching consignment');

  const history = card.find('.cargo__status-item').toArray().map(row => {
    const date = $(row).find('.cargo__status-date').clone();
    date.find('br').replaceWith(' ');
    const parts = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+([+-]\d{2}:\d{2})$/.exec(date.text().trim());
    const clock = parts ? explicitOffsetTime(`${parts[1]}T${parts[2]}${parts[3]}`) : null;
    const description = $(row).find('.cargo__status-name').text().trim();
    if (!clock || !description) throw new SchemaError(provider, 'Invalid GBS history row');
    const stage = stageForWording(normalizeStatusWording(description));
    const event: CarrierEvent = {
      time: clock.iso, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { timestamp: clock.timestamp, stage, event };
  }).sort((a, b) => b.timestamp - a.timestamp);
  const latest = history[0]?.event;
  if (!latest) throw new NoHistoryError(provider);
  const stage = history.find(scan => scan.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_update: latest.time, last_status_text: latest.description, events: history.map(scan => scan.event),
  };
}

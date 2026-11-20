import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { scanStage } from './status.js';

export const provider = 'flywing-cargo';

export function parseTracking(raw: string, number: string): CarrierResult {
  if (/<title>\s*(?:Access Denied|Just a moment|Security Check)|cf-chl|_Incapsula_Resource/i.test(raw)) {
    throw new ChallengeError(provider, 'Flywing Cargo requires verification');
  }
  const $ = load(raw);
  const headings = $('main h2');
  const missing = headings.filter((_, node) => $(node).text().trim() === 'GR Number Not Found');
  if (missing.length) {
    if (missing.parent().text().includes(`find a consignment for ${number}`)) throw new NotFoundError(provider);
    throw new IndeterminateError(provider, 'Flywing Cargo answered for a different GR number');
  }
  const summary = headings.filter((_, node) => $(node).text().trim() === `Consignment ${number}`);
  if (summary.length !== 1) {
    if (headings.toArray().some(node => /^Consignment\s+\d/.test($(node).text().trim()))) {
      throw new IndeterminateError(provider, 'Flywing Cargo answered for a different GR number');
    }
    throw new SchemaError(provider, 'Flywing Cargo did not return consignment details');
  }
  const result = summary.closest('section');
  const detail = (label: string) => result.find('table tr').filter((_, row) => $(row).children().first().text().trim() === label)
    .first().children().eq(1).text().trim();
  if (detail('GR No') !== number) throw new IndeterminateError(provider, 'Flywing Cargo did not confirm the exact GR number');
  const status = detail('Status');
  if (!status) throw new SchemaError(provider, 'Flywing Cargo omitted the consignment status');

  const journey = result.find('h3').filter((_, node) => $(node).text().trim() === 'Journey');
  const events = journey.length === 1 ? result.find('ol > li').toArray().flatMap(node => {
    const lines = $(node).find('p');
    const code = lines.eq(0).text().trim();
    const description = lines.eq(1).text().trim();
    const printed = description.match(/\b\d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}$/)?.[0];
    if (!printed) return [];
    const time = DateTime.fromFormat(printed, 'd LLL yyyy HH:mm', { locale: 'en', zone: 'utc' })
      .toISO({ includeOffset: false, suppressMilliseconds: true });
    if (!code || !time) throw new SchemaError(provider, 'Flywing Cargo returned an invalid journey movement');
    const stage = scanStage(code);
    const location = lines.eq(2).text().trim();
    return [{
      local_time: time, description, provider_code: code,
      ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    }];
  }).sort((left, right) => right.local_time.localeCompare(left.local_time)) : [];

  const stage = scanStage(status);
  const matching = events.find(event => event.provider_code === status);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: status,
    provider_code: status,
    ...(matching && { last_update_local: matching.local_time }),
    events,
  };
}

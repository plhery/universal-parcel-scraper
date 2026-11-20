import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { stageForWording } from './status.js';

export const provider = 'move-cargo';

export function parseTracking(html: string, reference: string): CarrierResult {
  const $ = load(html);
  if (/\b_cf_chl_opt\b|\bid=["']challenge-form["']/i.test(html) || /^(?:Just a moment|Access denied|Verification required)/i.test(clean($('title').text()))) {
    throw new ChallengeError(provider, 'Move Cargo returned a verification page');
  }

  const card = $('article.track-result');
  const missing = $('p.form-alert[role="status"]');
  if (!card.length && missing.length === 1 && clean(missing.text()).startsWith(`No shipment found for ${reference}.`)) {
    throw new NotFoundError(provider);
  }
  if (card.length !== 1) throw new SchemaError(provider, 'Move Cargo did not return one shipment card');
  const identity = card.find('.track-head .eyebrow');
  if (identity.length !== 1 || clean(identity.text()) !== reference) {
    throw new IndeterminateError(provider, 'Move Cargo did not identify the requested shipment');
  }

  const summary = card.find('.track-head .status');
  const wording = clean(summary.text());
  const timeline = card.children('ol.timeline');
  if (summary.length !== 1 || !wording || timeline.length > 1) {
    throw new SchemaError(provider, 'Invalid Move Cargo shipment card');
  }
  const stage = stageForWording(wording);
  const code = summary.attr('class')?.match(/\bstatus-([a-z-]+)\b/)?.[1];
  const service = clean(card.find('.track-head > div > p').not('.eyebrow').text(), 100);
  const events = timeline.children('li.is-done').toArray().reverse().map((node): CarrierEvent => {
    const row = $(node);
    const description = clean(row.children('strong').text());
    if (!description) throw new SchemaError(provider, 'Move Cargo returned a movement with no status');
    const location = clean(row.children('span').text());
    const clock = clean(row.children('time').text(), 64);
    const eventStage = stageForWording(description);
    return {
      description,
      ...(clock ? { provider_time_text: clock } : {}),
      ...(location && !hasPrivateDeliveryDetails(location) ? { location } : {}),
      ...(eventStage ? { stage: eventStage, stage_source: 'carrier_map' } : {}),
    };
  });
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    ...(code ? { provider_code: code } : {}),
    ...(service ? { service_name: service } : {}),
    last_status_text: wording,
    last_update: null,
    events,
  };
}

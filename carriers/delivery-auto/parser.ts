import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { clean } from '../../core/transport/index.js';
import statuses from './statuses.json' with { type: 'json' };

export const PROVIDER = 'Delivery';

const STAGES = new Map(statuses.entries.map(entry => [normalizeStatusWording(entry.wording), entry.stage as Stage]));

export function deliveryReceiptNumber(raw: string): string {
  const number = raw.length <= 32 ? raw.trim().replace(/^№\s*/, '').replace(/\s+/g, '') : '';
  if (!/^\d{10}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Delivery tracking takes a ten-digit receipt number');
  return number;
}

export function parseDeliveryReceipt(html: string, number: string): CarrierResult {
  const reply = html.trim();
  // The receipt page replaces precisely these two replies with its missing and ambiguous notices.
  if (!reply) throw new NotFoundError(PROVIDER);
  if (reply === '1') throw new IndeterminateError(PROVIDER, 'Delivery found more than one receipt for the reference');
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required)|cf-chl-|g-recaptcha|cf-turnstile/i.test(reply)) {
    throw new ChallengeError(PROVIDER, 'Delivery returned a verification page');
  }

  const $ = load(reply);
  const receipt = $('.tracking__container #SerialNumberItem');
  if (receipt.length !== 1) throw new SchemaError(PROVIDER, 'Delivery returned no unique receipt');
  if (receipt.text().trim() !== number) throw new IndeterminateError(PROVIDER, 'Delivery returned another receipt');

  const status = $('.tracking__container .main-status__info');
  const visible = status.children('.main-status__title').filter((_, node) => {
    const style = $(node).attr('style') ?? '';
    return $(node).attr('hidden') === undefined && !/\bdisplay\s*:\s*none\b/i.test(style);
  });
  const wording = clean(visible.text(), 240);
  if (status.length !== 1 || visible.length !== 1 || !wording) {
    throw new SchemaError(PROVIDER, 'Delivery returned no current receipt status');
  }

  const clock = status.find('.main-status__last-time');
  let local: string | undefined;
  if (clock.length) {
    const written = clock.find('time').map((_, node) => $(node).text().trim()).get().join(' ');
    const parsed = DateTime.fromFormat(written, 'dd.MM.yyyy HH:mm', { zone: 'UTC' });
    if (clock.length !== 1 || !parsed.isValid || parsed.toFormat('dd.MM.yyyy HH:mm') !== written) {
      throw new SchemaError(PROVIDER, 'Delivery returned an invalid receipt status date');
    }
    local = parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
  }

  const stage = STAGES.get(normalizeStatusWording(wording));
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: wording,
    last_update: null,
    ...(local ? { last_update_local: local } : {}),
    summary_only: true,
    events: [],
  };
}

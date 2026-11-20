import { load } from 'cheerio';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { fromLooseFormat } from '../../core/time/fields.js';
import { clean } from '../../core/transport/index.js';
import { statusMap } from './status.js';

export const PROVIDER = 'NCM Çapar';

const ANONYMOUS_FIELD = '__RequestVerificationToken';
const CHALLENGE = /<title>\s*(?:Just a moment|Access denied)|cf-challenge|_cf_chl_opt|(?:g-recaptcha|h-captcha)/i;

export function ncmNumber(input: string): string {
  const number = input.trim().toUpperCase();
  if (number.length > 32 || !/^NCM-?[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Enter the NCM tracking number');
  }
  return number;
}

export function parseNcmForm(html: string): string {
  const $ = load(html);
  const form = $('main form[method="post"]').filter((_, element) => $(element).find('input[name="TrackingNumber"]').length === 1);
  if (form.length !== 1 || form.attr('action')) {
    if (CHALLENGE.test(html.slice(0, 16_384))) throw new ChallengeError(PROVIDER);
    throw new SchemaError(PROVIDER, 'NCM Çapar returned a different tracking form');
  }
  const fields = form.find(`input[type="hidden"][name="${ANONYMOUS_FIELD}"]`);
  const formState = fields.length === 1 ? fields.attr('value') ?? '' : '';
  if (!/^[A-Za-z0-9_-]{20,1024}$/.test(formState)) throw new SchemaError(PROVIDER, 'Missing NCM Çapar form state');
  return formState;
}

export function parseNcmResult(html: string, number: string): CarrierResult {
  const $ = load(html);
  const section = $('main section').filter((_, element) => $(element).find('form input[name="TrackingNumber"]').length === 1);
  const result = section.find('article.card');
  if (!result.length && CHALLENGE.test(html.slice(0, 16_384))) throw new ChallengeError(PROVIDER);
  if (section.length !== 1) throw new SchemaError(PROVIDER, 'Missing NCM Çapar tracking page');
  if (result.length !== 1 || clean(result.find('h2').text(), 32).toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'NCM Çapar did not identify the requested shipment');
  }

  const list = result.find('ul.timeline');
  if (list.length !== 1) throw new SchemaError(PROVIDER, 'Missing NCM Çapar event history');
  const history = list.find('li.timeline__item').toArray().map(item => {
    const description = clean($(item).find('.timeline__title').text(), 160);
    const clock = fromLooseFormat(clean($(item).find('.timeline__meta').text(), 40), 'dd.MM.yyyy HH:mm', { zone: 'utc' });
    // UTC is used to check and sort the calendar digits. The page states no offset.
    const time = clock.toISO({ includeOffset: false, suppressMilliseconds: true });
    if (!time || !description) throw new SchemaError(PROVIDER, 'Incomplete NCM Çapar tracking event');
    const stage = statusMap.stage(null, normalizeStatusWording(description));
    const event: CarrierEvent = { time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    return { time, event };
  }).sort((a, b) => b.time.localeCompare(a.time));
  const events = history.map(({ event }) => event);
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });

  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: lead?.time } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}

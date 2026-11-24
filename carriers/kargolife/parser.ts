import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { windowEstimate } from '../../core/result/window.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { kargolifeStage } from './status.js';

export const PROVIDER = 'kargolife';
export const KARGOLIFE_MAX_BYTES = 256_000;
/** The tracker's answer for an order number it holds no order under. */
export const NOT_FOUND_NOTICE = 'Sipariş bulunamadı';
/** The heading the tracker puts over the delivery window. */
const WINDOW_HEADING = 'Tahmini Teslimat Tarihi';

const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|cf-chl-|cf-turnstile|g-recaptcha|hcaptcha/i;

/**
 * An order number is the marketplace's or the shop's own: Trendyol's are eleven digits, as the
 * recipient reads them in the order, sometimes with a leading #.
 */
export function normalizeKargolifeNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw.trim().replace(/^#/, ''));
  if (!/^\d{6,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Kargolife tracks an order by its order number of 6 to 20 digits');
  return number;
}

const isoDay = (year: number, month: number, day: number): string | null => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
};

/**
 * The delivery window as the tracker writes it, `28 - 02/06/2025`: the first day's month and year
 * are left out when they are the last day's, and a first day after the last is in the month before.
 */
export function kargolifeWindow(text: string): { from: string; to: string } | null {
  const match = /^(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{4}))?)?\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const [lastDay, lastMonth, lastYear] = [Number(match[4]), Number(match[5]), Number(match[6])];
  const firstDay = Number(match[1]);
  let firstMonth = match[2] ? Number(match[2]) : lastMonth;
  let firstYear = match[3] ? Number(match[3]) : lastYear;
  if (!match[2] && firstDay > lastDay) firstMonth -= 1;
  if (firstMonth === 0) [firstMonth, firstYear] = [12, firstYear - 1];
  if (!match[3] && firstMonth > lastMonth) firstYear = lastYear - 1;
  const [from, to] = [isoDay(firstYear, firstMonth, firstDay), isoDay(lastYear, lastMonth, lastDay)];
  return from && to && from <= to ? { from, to } : null;
}

/**
 * The tracker's page after its form is sent with an order number. The page draws the order's
 * steps as boxes, the one it has reached in orange (`c2`), and under them the delivery window.
 * An order number it does not hold gets one pink (`c0`) box with its not-found notice. The page
 * does not repeat the number; the tracker matches it whole, so the answer is the number asked.
 */
export function parseKargolife(html: string, raw: string): CarrierResult {
  normalizeKargolifeNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Kargolife answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  if ($('form input[name="numberOfOrder"]').length !== 1) throw new SchemaError(PROVIDER, 'Kargolife returned a page without its tracking form');
  const boxes = $('div.explanation').toArray().map((box) => ({
    className: ($(box).attr('class') ?? '').split(/\s+/).filter((name) => /^c\d$/.test(name)).join(' '),
    text: clean($(box).text(), 200),
  }));
  const steps = boxes.filter((box) => box.className !== 'c5');
  if (!steps.length) throw new SchemaError(PROVIDER, 'Kargolife returned its form without an answer');
  if (steps.length === 1 && steps[0]!.className === 'c0' && steps[0]!.text === NOT_FOUND_NOTICE) {
    throw new NotFoundError(PROVIDER, 'Kargolife has no order under this number');
  }
  if (steps.length > 12 || steps.some((step) => !/^c[1-4]$/.test(step.className) || !step.text)) {
    throw new SchemaError(PROVIDER, 'Kargolife returned an unexpected order step');
  }
  const reached = steps.filter((step) => step.className === 'c2');
  if (reached.length !== 1) throw new SchemaError(PROVIDER, 'Kargolife returned an order without its current step');
  const wording = reached[0]!.text;
  const stage = kargolifeStage(wording);

  const windows = boxes.filter((box) => box.className === 'c5');
  const heading = clean($('div.tahmini').text(), 80);
  if (windows.length > 1 || (windows.length === 1) !== (heading === WINDOW_HEADING)) {
    throw new SchemaError(PROVIDER, 'Kargolife changed its delivery window');
  }
  const written = windows[0]?.text ?? '';
  const window = written ? kargolifeWindow(written) : null;
  // A delivered order keeps the window it was planned in; it no longer says when the order comes.
  const estimate = window && stage !== 'delivered' ? windowEstimate(window.from, window.to) : { expected_delivery: null };

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: wording,
    last_update: null,
    ...estimate,
    ...(written && !window ? { unread_estimates: [WINDOW_HEADING] } : {}),
    summary_only: true,
    events: [],
  };
}

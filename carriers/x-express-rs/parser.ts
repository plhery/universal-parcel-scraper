import { ChallengeError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { xExpressRsRequestNumber } from './number.js';
import { xExpressRsStage } from './status.js';

export const PROVIDER = 'X Express Serbia';
/** The tracker's share link for one shipment, which its result page publishes beside the number. */
export const X_EXPRESS_RS_PAGE = 'https://www.x-express.rs/korisnicki-panel/pracenje-posiljke';
// The host's "One moment, please..." page, which checks the browser and reloads itself.
const CHALLENGE = /<title>\s*(?:One moment, please|Just a moment|Attention Required|Access denied)|wsidchk|Please wait while your request is being verified|_cf_chl_opt|cf-turnstile/i;
const MISSING = /<div class="forma_neuspjesno">\s*Pošiljka sa kodom <b>([^<]{1,64})<\/b> nije pronađena/;
const CAPTCHA_FAILED = /<div class="forma_neuspjesno">\s*Došlo je do greške prilikom ReCaptcha validacije/;
const NUMBER = /<span>\s*Broj pošiljke:\s*([^<]{1,64}?)\s*<\/span>/;
const STATUS = /<div class="pracenje-result-status"[^>]*>([^<]{1,200})<\/div>/;
// "24-09-26 16:34": day, month, two-digit year and minutes on Belgrade's clock.
const STEP = /<div class="pracenje-track-title_v2">([^<]{1,200})<\/div>\s*<div class="pracenje-track-vrijeme_v2">\s*(\d{2})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d)\s*<\/div>/;
const MAX_STEPS = 100;

/**
 * The tracker's page for one shipment number: the number it found, the current status, the
 * recipient, the recipient's address and the sender, and the scans newest first, each with its
 * wording and minute on Belgrade's clock. The parties are left out. A page saying the number
 * was not found, for the number asked, is a shipment X Express does not know.
 */
export function parseXExpressRs(html: string, raw: string): CarrierResult {
  const number = xExpressRsRequestNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'X Express Serbia returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'X Express Serbia answered with a browser check');
  const start = html.indexOf('<div class="pracenje-result">');
  if (start < 0) {
    const missing = MISSING.exec(html);
    if (missing && textFromHtml(missing[1], 64) === number) throw new NotFoundError(PROVIDER);
    if (missing) throw new SchemaError(PROVIDER, 'X Express Serbia answered for another number');
    if (CAPTCHA_FAILED.test(html)) throw new ChallengeError(PROVIDER, 'X Express Serbia refused its reCAPTCHA check');
    throw new SchemaError(PROVIDER, 'X Express Serbia returned a page without a shipment');
  }
  const result = html.slice(start);
  // The tracker can answer for another shipment than the one asked; only the whole number counts.
  const echoed = NUMBER.exec(result);
  if (!echoed || textFromHtml(echoed[1], 64) !== number) throw new SchemaError(PROVIDER, 'X Express Serbia answered for another shipment');
  const boxes = result.split(/<div class="pracenje-track-box_v2[^"]*">/).slice(1);
  if (boxes.length > MAX_STEPS) throw new SchemaError(PROVIDER, 'X Express Serbia returned too many scans');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const box of boxes) {
    const match = STEP.exec(box);
    const date = match && calendarDay(2000 + +match[4]!, +match[3]!, +match[2]!);
    const wording = match ? textFromHtml(match[1], 200) : '';
    if (!match || !date || !wording) throw new SchemaError(PROVIDER, 'X Express Serbia returned an invalid scan');
    const stage = xExpressRsStage(wording);
    const event: CarrierEvent = { local_time: `${date}T${match[5]}:00`, description: wording,
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const current = textFromHtml(STATUS.exec(result)?.[1] ?? '', 200);
  // The page lists the scans newest first, as it marks the first one the latest.
  const newest = events[0];
  if (!newest && !current) throw new SchemaError(PROVIDER, 'X Express Serbia returned a shipment without a status or scans');
  const stage = newest ? newest.stage as ReturnType<typeof xExpressRsStage> : xExpressRsStage(current);
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest?.description ?? current, last_update: null,
    ...(newest ? { last_update_local: newest.local_time! } : { summary_only: true }), events };
}

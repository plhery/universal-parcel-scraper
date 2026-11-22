import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { textFromHtml } from '../../core/transport/text.js';
import { hdtStage } from './status.js';

export const PROVIDER = 'Home Delivery Team';
/** The tracking page, which shows an order's steps for the number in its `track_number` parameter. */
export const HDT_PAGE = 'https://homedt.hu/nyomonkovetes';
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access denied|One moment, please)|imunify360|wsidchk/i;
const MISSING = /<h2>\s*Sajnos a keresett megrendelés nem szerepel rendszerünkben!\s*<\/h2>/;
// "Időpont: 2026-05-29 10:21:29<br />A címzett megkapta…": the step's wall clock in Budapest, then its sentence.
const STEP = /<h2>([^<]{1,120})<\/h2>\s*<p>\s*Időpont:\s*(\d{4})-(\d{2})-(\d{2}) ((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)\s*(?:<br\s*\/?>([^<]{0,300}))?<\/p>/;
const MAX_STEPS = 100;

/** An order number: the last group of the waybill's identifier, seven digits on today's orders. */
export function normalizeHdtNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[1-9]\d{5,7}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Home Delivery Team tracks the order number, the last group of digits on the waybill');
  return number;
}

/**
 * The tracking page for one order number: its steps, oldest first, each with a status title,
 * the time on Budapest's clock and a sentence. A page saying the order is not in the system is
 * a number HDT does not know.
 */
export function parseHdt(html: string, raw: string): CarrierResult {
  normalizeHdtNumber(raw);
  if (typeof html !== 'string' || !html) throw new SchemaError(PROVIDER, 'Home Delivery Team returned an empty page');
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Home Delivery Team answered with a browser check');
  const start = html.indexOf('<section class="ny-area">');
  const area = start < 0 ? undefined : html.slice(start, html.indexOf('</section>', start));
  if (!area) throw new SchemaError(PROVIDER, 'Home Delivery Team returned a page without its tracking area');
  if (MISSING.test(area)) throw new NotFoundError(PROVIDER);
  const boxes = area.split('<div class="boxs">').slice(1);
  if (!boxes.length) throw new SchemaError(PROVIDER, 'Home Delivery Team returned a tracking area without steps');
  if (boxes.length > MAX_STEPS) throw new SchemaError(PROVIDER, 'Home Delivery Team returned too many steps');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const box of boxes) {
    const match = STEP.exec(box);
    const date = match && calendarDay(+match[2]!, +match[3]!, +match[4]!);
    if (!match || !date) throw new SchemaError(PROVIDER, 'Home Delivery Team returned an invalid step');
    const title = textFromHtml(match[1], 120);
    if (!title) throw new SchemaError(PROVIDER, 'Home Delivery Team returned a step without its status');
    const sentence = textFromHtml(match[6] ?? '', 300);
    const stage = hdtStage(title);
    // The steps name no place, except the central warehouse in Budapest.
    const event: CarrierEvent = { local_time: `${date}T${match[5]}`, description: sentence || title, provider_code: title,
      ...(/budapesti központi raktár/i.test(sentence) ? { location: 'Budapest' } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  // Newest first, reversing the page's order so steps of one second keep the carrier's.
  events.reverse();
  const newest = events[0]!;
  const stage = newest.stage as ReturnType<typeof hdtStage>;
  return { status: stage ? languageStageStatus(stage) : 'unknown', ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time!, events };
}

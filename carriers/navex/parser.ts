import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { navexRequestNumber } from './number.js';
import { navexStage } from './status.js';

export const PROVIDER = 'Navex Delivery';
// The page is about fifteen kilobytes, most of it its stylesheet.
export const NAVEX_MAX_BYTES = 512 * 1024;
const ZONE = 'Africa/Tunis';
const FORMAT = "dd/MM/yyyy 'à' HH:mm";
const CLOCK = /^\d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}$/;
// A CDN's or firewall's page in place of the tracker's, which can come back with HTTP 200.
const BLOCKED = /_cf_chl_opt|cf-turnstile|challenge-platform|g-recaptcha|h-captcha|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i;
const NOT_FOUND = /^Aucun colis trouvé pour ce numéro de suivi\.?$/;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;

/** The tracker's search field, which shows the number the page was asked about. */
function searchField($: CheerioAPI, html: string): Cheerio<AnyNode> {
  const field = $('form input[name="track"]');
  if (field.length === 1) return field;
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Navex answered with a browser check');
  throw new SchemaError(PROVIDER, 'Navex did not return its tracking page');
}

/**
 * A row's clock: the tracker's wall clock to the minute, which is Tunisia's.
 * Tunisia keeps one offset all year.
 */
function scanTime(text: string): string {
  const wall = CLOCK.test(text) ? firstOccurrence(DateTime.fromFormat(text, FORMAT, { zone: ZONE })) : null;
  // Luxon rolls 24:00 over to the next day; only a clock that reads back unchanged is kept.
  const iso = wall?.isValid && wall.toFormat(FORMAT) === text ? wall.toISO({ suppressMilliseconds: true }) : null;
  if (!iso) throw new SchemaError(PROVIDER, 'Navex returned an invalid event time');
  return iso;
}

/** The value under a label of the card above the history. */
function card($: CheerioAPI, label: string): string {
  const item = $('.info-card .item').filter((_, node) => clean($(node).children('.label').text(), 60) === label);
  return item.length === 1 ? clean(item.children('.value').text(), 200) : '';
}

/** The history, newest first: each row's clock, wording and depot, without the note under it. */
function history($: CheerioAPI): CarrierEvent[] {
  const rows = $('.timeline > .timeline-item').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Navex returned an oversized history');
  const scans: { time: string; timestamp: number; order: number; description: string; location: string }[] = [];
  const seen = new Set<string>();
  for (const [order, row] of rows.entries()) {
    const label = $(row).children('.label');
    if (label.length !== 1) throw new SchemaError(PROVIDER, 'Navex returned an invalid history row');
    // The depot follows the wording after a dash; the icon before it has no text.
    const location = clean(label.children('span').text(), 80).replace(/^[—–-]\s*/, '');
    const wording = label.clone();
    wording.children('i, span').remove();
    const description = clean(wording.text(), 200);
    if (!description) throw new SchemaError(PROVIDER, 'Navex returned an event without wording');
    const time = scanTime(clean($(row).children('.date').text(), 40));
    const key = `${time}\n${description}\n${location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scans.push({ time, timestamp: DateTime.fromISO(time).toMillis(), order, description, location });
  }
  // Newest first, as the page lists them; rows of the same minute keep its order.
  scans.sort((left, right) => right.timestamp - left.timestamp || left.order - right.order);
  return scans.map(({ time, description, location }) => {
    const staged = navexStage(description);
    return { time, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
  });
}

/**
 * The page `GET /track.php?track=<number>` answers with: the search form
 * showing the number, then either a notice that Navex holds no parcel under
 * it, or the parcel's card, headed with its number, and its history newest
 * first. The answer is read only when the form and the card show the whole
 * number asked.
 */
export function parseNavex(html: string, raw: string): CarrierResult {
  const number = navexRequestNumber(raw);
  const $ = load(html);
  const field = searchField($, html);
  if (clean(field.attr('value') ?? '', 64) !== number) throw new SchemaError(PROVIDER, 'Navex did not look the number up');
  const notice = clean($('.body .alert.error').text(), 200);
  if (NOT_FOUND.test(notice)) throw new NotFoundError(PROVIDER);
  if (notice) throw new SchemaError(PROVIDER, 'Navex answered with a notice it does not usually give');
  if (!$('.info-card').length) throw new SchemaError(PROVIDER, 'Navex returned neither a parcel nor a notice');
  if (card($, 'Numéro de suivi') !== number) throw new IndeterminateError(PROVIDER, 'Navex answered for another shipment');

  const events = history($);
  if (!events.length) throw new NoHistoryError(PROVIDER);
  const newest = events[0]!;
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const sender = card($, 'Expéditeur');
  const destination = card($, 'Destination');
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    ...(stage === 'delivered' ? { delivered_at: current!.time! } : {}),
    expected_delivery: null,
    ...(sender ? { sender_name: sender } : {}),
    ...(destination ? { receiver_address: destination } : {}),
    events: events.slice(0, MAX_EVENTS),
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

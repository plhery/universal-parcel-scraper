import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { jetspeedRowStage } from './status.js';

export const PROVIDER = 'jetspeed';
export const JETSPEED_ORIGIN = 'https://www.jetspeed-express.com';
export const JETSPEED_MAX_BYTES = 512 * 1024;
// One number: the tracker reads a semicolon as a list of several.
export const JETSPEED_NUMBER = /^[A-Z0-9]{6,40}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) ([0-2]\d:[0-5]\d:[0-5]\d)$/;
// The tracker writes every row on its own clock in Shenzhen, wherever the scan was, as Quick Fort's
// tracker on the same platform does on Hong Kong's.
export const JETSPEED_ZONE = 'Asia/Shanghai';
// The site's error page for a number its tracker holds no order for.
const NO_ORDER = '未查询到对应订单，请确认您输入的单号无误。';

/** The tracker's page for one number, which carries it in its path. */
export function jetspeedUrl(number: string): string {
  return `${JETSPEED_ORIGIN}/search_kuai_di/search/orderid/${encodeURIComponent(number)}`;
}

const text = (value: string) => value.replace(/\s+/g, ' ').trim();

// The places rows name in their wording: the origin's town, with its state and country, ahead of
// or inside the words; the origin hub in brackets; the country of the airport or facility the
// parcel reached; the town the delivery station serves, before its postcode.
const PLACES: readonly ((wording: string) => string | undefined)[] = [
  (wording) => /^(.+?),([A-Z]{2}),([A-Z]{2}),[^,]+,Order information received by the carrier\.?$/.exec(wording)?.slice(1).join(', '),
  (wording) => {
    const match = /^Consignment received at the local warehouse in ([A-Z]{2}),([A-Z]{2}),[^,]+,(.+)\.$/.exec(wording);
    return match ? `${match[3]}, ${match[1]}, ${match[2]}` : undefined;
  },
  (wording) => /^Origin processing completed \[(.+)\]\.$/.exec(wording)?.[1],
  (wording) => /^Shipment arrived at (?:the )?([A-Z]{2}) (?:Airport|destination processing facility\.)$/.exec(wording)?.[1],
  (wording) => /, serving (.+?),\d{4,5}\.$/.exec(wording)?.[1],
  // The other line's hub, town or country, in brackets before or after the words.
  (wording) => /^\[([^\]]{1,60})\] /.exec(wording)?.[1] ?? / \[([^\]]{1,60})\]\.?$/.exec(wording)?.[1],
];
const DESTINATION = /^Shipment arrived at the ([A-Z]{2}) destination processing facility\.$/;

/** The place a row's wording names, if any. */
export function jetspeedPlace(wording: string): string | undefined {
  for (const read of PLACES) {
    const place = read(wording)?.trim();
    if (place) return place;
  }
  return undefined;
}

/**
 * The tracker's server-rendered answer for `number`. Its rows carry wall clocks without a zone, all
 * on the tracker's clock: each keeps its wall clock and is dated on that clock, and keeps the place
 * its wording names.
 */
export function parseJetspeedPage(html: string, number: string): CarrierResult {
  const $ = load(html);
  const result = $('#result .main-content');
  if (result.length !== 1) {
    if ($('title').text().trim() === '温馨提示' && text($('.system-message.error h1').text()) === NO_ORDER) throw new NotFoundError(PROVIDER);
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(html)) {
      throw new ChallengeError(PROVIDER, 'JETSPEED requires verification');
    }
    throw new SchemaError(PROVIDER, 'Missing JETSPEED tracking results');
  }
  const label = result.find('p').filter((_, element) => text($(element).text()).startsWith('单号：')).first();
  const shown = text(label.find('strong').first().text()).toUpperCase();
  if (!label.length) throw new SchemaError(PROVIDER, 'JETSPEED named no number');
  if (shown !== number) throw new IndeterminateError(PROVIDER, 'JETSPEED answered for another number');

  const events: CarrierEvent[] = [];
  for (const item of result.find('.timeline .timeline-item').toArray()) {
    const clock = CLOCK.exec(text($(item).children('.time').text()));
    const description = text($(item).children('.context').text());
    if (!clock || !description) throw new SchemaError(PROVIDER, 'Invalid JETSPEED history row');
    const staged = jetspeedRowStage(description);
    const location = jetspeedPlace(description);
    const local = `${clock[1]}T${clock[2]}`;
    const time = isoTime(local, JETSPEED_ZONE)!.iso;
    events.push({ time, local_time: local, time_zone: JETSPEED_ZONE, time_zone_basis: 'carrier', description,
      ...(location ? { location } : {}), ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  // The page lists rows newest first; keep that order for rows of one second.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER);
  const staged = events.map((event) => jetspeedRowStage(event.description!)).find(Boolean);
  const destination = events.map((event) => DESTINATION.exec(event.description!)?.[1]).find(Boolean);
  return {
    status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    ...(destination ? { destination_country: destination } : {}),
    last_status_text: latest.description, last_update: latest.time, last_update_local: latest.local_time, events,
  };
}

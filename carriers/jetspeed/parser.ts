import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { jetspeedStage } from './status.js';

export const PROVIDER = 'jetspeed';
export const JETSPEED_ORIGIN = 'https://www.jetspeed-express.com';
export const JETSPEED_MAX_BYTES = 512 * 1024;
// One number: the tracker reads a semicolon as a list of several.
export const JETSPEED_NUMBER = /^[A-Z0-9]{6,40}$/;
const CLOCK = /^(\d{4}-\d{2}-\d{2}) ([0-2]\d:[0-5]\d:[0-5]\d)$/;
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
 * The tracker's server-rendered answer for `number`. Its rows carry wall clocks without a zone,
 * written at the parcel's origin, which can be abroad, and at its destination: each keeps its wall
 * clock, and the place its wording names, which lets a lookup date it on that place's clock.
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
    const stage = jetspeedStage(normalizeStatusWording(description));
    const location = jetspeedPlace(description);
    events.push({ local_time: `${clock[1]}T${clock[2]}`, description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) });
  }
  // The page lists rows newest first; keep that order for rows of one second.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER);
  const stage = events.map((event) => jetspeedStage(normalizeStatusWording(event.description!))).find(Boolean);
  const destination = events.map((event) => DESTINATION.exec(event.description!)?.[1]).find(Boolean);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' as const } : {}),
    ...(destination ? { destination_country: destination } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time, events,
  };
}

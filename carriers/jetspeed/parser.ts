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

/**
 * The tracker's server-rendered answer for `number`. Its rows carry wall clocks without a zone:
 * the parcel's origin, abroad, and its destination write on their own clocks, so each keeps its
 * wall clock.
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
    events.push({ local_time: `${clock[1]}T${clock[2]}`, description, ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) });
  }
  // The page lists rows newest first; keep that order for rows of one second.
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER);
  const stage = events.map((event) => jetspeedStage(normalizeStatusWording(event.description!))).find(Boolean);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' as const } : {}),
    last_status_text: latest.description, last_update: null, last_update_local: latest.local_time, events,
  };
}

import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { libanPostStage } from './status.js';

export const PROVIDER = 'LibanPost';
export const LIBANPOST_MAX_BYTES = 512 * 1024;
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|403 Forbidden|Request Rejected)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;
const NOT_FOUND = 'No results matching your tracking number, please try a different tracking number';

/** The official guest form accepts one item reference without a published format restriction. */
export function normalizeLibanPostNumber(raw: string): string {
  const number = raw.length <= 80 && /^[A-Za-z0-9\s-]+$/.test(raw) ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{4,40}$/.test(number) || !/\d/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

function detail($: CheerioAPI, label: string): string | null {
  const lines = $('#cpMain_divTrackSummary .simpleList > li').filter((_, li) => clean($(li).children('label').text()) === label);
  if (lines.length > 1 || (lines.length === 1 && lines.children('span.trackNumber').length !== 1)) {
    throw new SchemaError(PROVIDER, 'LibanPost repeated a shipment detail');
  }
  return lines.length ? lines.children('span.trackNumber').text().trim() : null;
}

function clock(date: string, time: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) throw new SchemaError(PROVIDER, 'LibanPost returned an invalid scan clock');
  const parsed = DateTime.fromObject({ year: +m[3]!, month: +m[2]!, day: +m[1]!, hour: +t[1]!, minute: +t[2]! }, { zone: 'UTC' });
  if (!parsed.isValid || parsed.year < 2000 || +t[1]! >= 24) throw new SchemaError(PROVIDER, 'LibanPost returned an invalid scan clock');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** The mobile page prints one exact identity, a shipment summary and all scans oldest first. */
export function parseLibanPost(html: string, raw: string): CarrierResult {
  const number = normalizeLibanPostNumber(raw);
  if (BLOCKED.test(html.slice(0, 128_000))) throw new ChallengeError(PROVIDER, 'LibanPost answered with a verification page');
  if (!html.trim()) throw new IndeterminateError(PROVIDER, 'LibanPost returned an empty page');
  const $ = load(html);
  const summary = $('#cpMain_divTrackSummary');
  const history = $('#cpMain_divTrackTable');
  if (summary.length > 1 || history.length > 1) throw new SchemaError(PROVIDER, 'LibanPost repeated its tracking sections');
  if (!summary.length) {
    // The lookup is scoped by the whole sn query. The site's explicit negative notice
    // appears only after lookup; its empty search form alone is inconclusive.
    const notice = $('#cpMain_divNoData');
    if ($('#cpMain_panelTrace').length === 1 && notice.length === 1
      && clean(notice.clone().children().remove().end().text()) === NOT_FOUND) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'LibanPost did not return a tracking result');
  }
  const identity = detail($, 'Shipment number');
  if (!identity) throw new SchemaError(PROVIDER, 'LibanPost did not name the shipment');
  if (normalizeTrackingNumber(identity) !== number) throw new IndeterminateError(PROVIDER, 'LibanPost answered for another shipment');
  const origin = clean(detail($, 'Source location'));
  const destination = clean(detail($, 'Intended location'));
  if (origin !== 'LEBANON' && destination !== 'LEBANON') throw new IndeterminateError(PROVIDER, 'LibanPost did not identify a Lebanese postal leg');
  if (history.length !== 1) throw new SchemaError(PROVIDER, 'LibanPost omitted its scan section');
  const rows = history.find('.trackingListing');
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'LibanPost returned an oversized history');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  rows.each((_, node) => {
    const row = $(node);
    const date = row.find('.trackDate');
    const time = date.children('.trackTime');
    const wording = row.find('.trackEvent');
    const place = row.find('.trackLocation');
    if (date.length !== 1 || time.length !== 1 || wording.length !== 1 || place.length !== 1) throw new SchemaError(PROVIDER, 'LibanPost changed its scan layout');
    // Delivery wordings can append a recipient's signature name; it is not scan wording.
    const description = clean(wording.text().split(/\s+Signed\s*:/i)[0], 300);
    if (!description) throw new SchemaError(PROVIDER, 'LibanPost returned a scan without wording');
    const location = clean(place.text(), 160);
    const local = clock(clean(date.clone().children().remove().end().text()), clean(time.text()));
    const staged = libanPostStage(description);
    const event: CarrierEvent = { local_time: local, description, ...(location ? { location } : {}),
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) };
    const key = JSON.stringify(event);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  });
  if (!events.length) throw new NoHistoryError(PROVIDER);
  // The page gives clocks without an offset. Preserve the
  // carrier sequence across international zones rather than sort unlike clocks.
  events.reverse();
  const latest = events[0]!;
  const staged = events.find(event => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const service = clean(detail($, 'Name of service'), 120);
  return { status: stage ? languageStageStatus(stage) : 'unknown',
    ...(staged?.stage ? { current_stage: staged.stage, current_stage_source: staged.stage_source } : {}),
    last_status_text: latest.description!, last_update: null, last_update_local: latest.local_time,
    expected_delivery: null, ...(service ? { service_name: service } : {}),
    ...(destination === 'LEBANON' ? { destination_country: 'LB' } : destination ? { destination_country_name: destination } : {}), events };
}

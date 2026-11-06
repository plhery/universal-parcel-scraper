import { load } from 'cheerio';
import { isPostOneReference } from '../../core/detection/postOne.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { isSpsLookup } from '../../core/detection/sps.js';
import { ChallengeError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { postOneStatus } from './status.js';

export const PROVIDER = 'Post One';
export const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const ORIGIN = 'https://postone.eu';
const HIDDEN = '[hidden],[aria-hidden="true"],.hide,.hidden,.d-none,[style*="display:none"],[style*="display: none"]';
const compact = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function normalizePostOneNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!isPostOneReference(number)) throw new InvalidInputError(PROVIDER, 'Post One needs its whole item number');
  return number;
}

export function postOneTrackingUrl(raw: string): string {
  return ORIGIN + '/en/track?code=' + encodeURIComponent(normalizePostOneNumber(raw));
}

function clock(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) ([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  const year = Number(match?.[3]);
  const day = match && year >= 2000 && year <= 2100 ? calendarDay(year, Number(match[2]), Number(match[1])) : null;
  if (!match || !day) throw new SchemaError(PROVIDER, 'Post One returned an invalid scan clock');
  return day + 'T' + match[4] + ':' + match[5] + (match[6] === undefined ? '' : ':' + match[6]);
}

function statusIcon(raw: string | undefined): string | null {
  if (!raw || raw.length > 256) return null;
  try {
    const url = new URL(raw, ORIGIN);
    return url.origin === ORIGIN && !url.search && !url.hash && !url.username && !url.password
      && /^\/assets\/images\/tracking\/[a-z0-9-]+\.png$/.test(url.pathname) ? url.pathname.split('/').at(-1)! : null;
  } catch { return null; }
}

/** Server-rendered own-item logistics only; all arbitrary page and recipient prose stays out. */
export function parsePostOneTrackingHtml(html: string, raw: string): CarrierResult {
  const number = normalizePostOneNumber(raw);
  if (html.length > MAX_BYTES || new TextEncoder().encode(html).byteLength > MAX_BYTES) {
    throw new SchemaError(PROVIDER, 'Post One returned too much tracking data');
  }
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required|403 Forbidden|Request Rejected)|_cf_chl_opt|cf-turnstile|\/cdn-cgi\/challenge-platform\/|["'](?:challenge-form|cf-challenge-running)["']|>\s*Verify (?:that )?you are human/i.test(html)) {
    throw new ChallengeError(PROVIDER, 'Post One returned browser verification');
  }
  const $ = load(html); $('script,style,template').remove();
  const ownLabels = $('label').filter((_, element) => compact($(element).text()) === 'item_number');
  const panel = ownLabels.closest('div.form-horizontal'), section = panel.parent('section.container');
  if (ownLabels.length !== 1 || !ownLabels.hasClass('control-label') || ownLabels.closest(HIDDEN).length
    || panel.length !== 1 || section.length !== 1 || section.find('div.form-horizontal').length !== 1) {
    throw new SchemaError(PROVIDER, 'Post One returned no unique own-item identity');
  }
  const field = (key: string) => {
    const labels = panel.find('label').filter((_, element) => compact($(element).text()) === key);
    const group = labels.parent('.form-group'), value = group.children('div.col-sm-7');
    return labels.length === 1 && labels.hasClass('control-label') && group.length === 1 && value.length === 1
      && group.children().length === 2 && !group.closest(HIDDEN).length && !labels.closest(HIDDEN).length
      && !value.closest(HIDDEN).length && !value.find(HIDDEN).length ? value : null;
  };
  const ownValue = field('item_number');
  if (!ownValue || compact(ownValue.text()) !== number) {
    throw new SchemaError(PROVIDER, 'Post One returned a different or malformed whole item number');
  }
  const history = section.children('div.col-md-4'), rows = history.children('div.row');
  if (history.length !== 1 || rows.length !== history.children().length || rows.length > MAX_ROWS
    || rows.find('p.item').length !== rows.length || $('p.item').length !== rows.length) {
    throw new SchemaError(PROVIDER, 'Post One returned unrelated or excessive history rows');
  }
  const scans: { event: CarrierEvent; index: number; key: string }[] = [];
  for (const [index, row] of rows.toArray().entries()) {
    const content = $(row).children('div.col-sm-9'), item = content.children('p.item');
    const icon = $(row).children('div.col-sm-3').children('img');
    if (content.length !== 1 || item.length !== 1 || icon.length !== 1 || $(row).children().length !== 2) {
      throw new SchemaError(PROVIDER, 'Post One changed a tracking row');
    }
    if (!item.hasClass('is-done') || item.closest(HIDDEN).length) continue;
    const heading = item.children('strong');
    if (heading.length !== 1 || heading.closest(HIDDEN).length || item.children().not('strong,br').length || item.children('br').length !== 1) {
      throw new SchemaError(PROVIDER, 'Post One changed a reached scan');
    }
    const wording = compact(heading.text());
    if (!wording || wording.length > 1000) throw new SchemaError(PROVIDER, 'Post One returned an invalid scan status');
    const date = item.clone(); date.children('strong,br').remove();
    const local_time = clock(compact(date.text())), known = postOneStatus(wording), image = statusIcon(icon.attr('src'));
    if (known && image !== known.icon) throw new SchemaError(PROVIDER, 'Post One returned contradictory scan markers');
    const event: CarrierEvent = { local_time, description: known?.wording ?? 'Tracking update',
      ...(known ? { provider_code: known.code, stage: known.stage, stage_source: 'carrier_map' } : {}) };
    scans.push({ event, index, key: JSON.stringify(event) });
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER, 'Post One knows the item but returned no reached scans', { reason: 'parcel_found' });
  // Every source row is checked before deduplication, ordering and the public output cap.
  const seen = new Set<string>();
  const distinct = scans.filter(scan => { if (seen.has(scan.key)) return false; seen.add(scan.key); return true; });
  distinct.sort((a, b) => b.event.local_time!.localeCompare(a.event.local_time!) || b.index - a.index);
  const events = distinct.map(scan => scan.event), newest = events[0]!, stage = postOneStatus(newest.description!)?.stage;
  const partnerNumber = field('tracking_number'), partnerName = field('partner'), partnerLink = field('tracking_link');
  let handoff: Pick<CarrierResult, 'delivery_carrier' | 'delivery_tracking_number'> = {};
  if (partnerNumber && partnerName && partnerLink && compact(partnerName.text()).toUpperCase() === 'SPS SLOVAKIA') {
    const label = compact(partnerNumber.text()), links = partnerLink.find('a');
    const partner = label.length <= 64 && /^[A-Z0-9 .-]+$/i.test(label) ? normalizeTrackingNumber(label) : '';
    const href = links.attr('href');
    if (partner && isSpsLookup(partner) && links.length === 1 && href && href.length <= 2048) {
      try {
        const url = new URL(href), linked = url.searchParams.getAll('shipment_id');
        if (url.protocol === 'https:' && url.hostname === 'www.sps-sro.sk' && !url.port && !url.username && !url.password
          && url.pathname === '/sledovanie-zasielky/' && !url.hash && linked.length === 1 && linked[0]!.length <= 64
          && normalizeTrackingNumber(linked[0]!) === partner && url.searchParams.getAll('country_id').length <= 1
          && [...url.searchParams.keys()].every(key => key === 'shipment_id' || key === 'country_id')) {
          handoff = { delivery_carrier: 'slovak-parcel-service', delivery_tracking_number: partner };
        }
      } catch { /* Optional routing evidence cannot invalidate the bound own history. */ }
    }
  }
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, expected_delivery: null,
    // This reached-milestone view must leave room for the delivery partner's detailed scans.
    history_truncated: true,
    ...handoff, events: events.slice(0, MAX_EVENTS),
  };
}

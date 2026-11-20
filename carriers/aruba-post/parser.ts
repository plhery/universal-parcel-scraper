import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { laPosteBurkinaFasoEventStage } from '../la-poste-burkina-faso/status.js';

export const provider = 'aruba-post';
const headings = ['Local Date and Time', 'Country', 'Location', 'Event Type', 'Mail Category', 'Next Office', 'Extra Information'];
const text = (value: string) => value.replace(/\s+/g, ' ').trim();

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const items = $('td > strong').filter((_, node) => text($(node).text()).startsWith('ITEM n° '));
  if (!items.length && $('title').text().trim() === 'IPS Web Tracking/Item Events' &&
    $('p > strong').toArray().some(node => text($(node).text()) === 'No information, please check your item identifier')) {
    throw new NotFoundError(provider);
  }
  if (items.length !== 1) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
      throw new ChallengeError(provider, 'Post Aruba requires verification');
    }
    throw new SchemaError(provider, 'Missing Post Aruba item details');
  }
  if (text(items.text()) !== `ITEM n° ${number}`) throw new IndeterminateError(provider, 'Post Aruba answered for another item');
  const rows = items.closest('table').children('tbody').children('tr');
  const columns = rows.eq(1).children('td').map((_, node) => text($(node).text())).get();
  if (columns.join('|') !== headings.join('|')) throw new SchemaError(provider, 'Post Aruba history columns changed');
  const scans = rows.slice(2).toArray().map(row => {
    const cells = $(row).children('td');
    const clock = DateTime.fromFormat(text(cells.eq(0).text()), 'M/d/yyyy h:mm:ss a', { zone: 'utc', locale: 'en-US' });
    const country = text(cells.eq(1).text()).replace(/\s+\(the\)$/i, '');
    const office = text(cells.eq(2).text());
    const description = text(cells.eq(3).text());
    if (cells.length !== 8 || !clock.isValid || !description) throw new SchemaError(provider, 'Invalid Post Aruba history row');
    const stage = laPosteBurkinaFasoEventStage(description);
    const location = [office === '-' ? '' : office, country].filter(Boolean).join(', ');
    const event: CarrierEvent = {
      description, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { event, stage };
  }).reverse();
  const latest = scans[0]?.event;
  if (!latest) throw new NoHistoryError(provider);
  const stage = scans.find(scan => scan.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update_local: latest.local_time, events: scans.map(scan => scan.event),
  };
}

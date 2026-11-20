import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { scanStage } from './status.js';

export const provider = 'translink-shipping';

export function parseTracking(html: string, number: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(html)) {
    throw new ChallengeError(provider, 'Translink requires verification');
  }
  const $ = load(html);
  const bill = $('table.GridView2 th').filter((_, node) => $(node).text().trim() === 'H B/L#:').next('td');
  const missing = $('div.error').filter((_, node) => $(node).text().replace(/\s+/g, ' ').trim() === `No Data Found ${number}`);
  if (bill.length === 0 && missing.length === 1) throw new NotFoundError(provider);
  if (bill.length !== 1) throw new SchemaError(provider, 'Translink omitted the house bill identifier');
  if (bill.text().trim() !== number) throw new IndeterminateError(provider, 'Translink answered for a different house bill');

  const links = $('a[key=detail]');
  const container = links.length === 1 ? links.attr('cntno') : undefined;
  if (!container || !/^[A-Z]{4}\d{7}$/.test(container)) {
    throw new IndeterminateError(provider, 'Translink did not return a single-container house bill', { reason: 'listed' });
  }
  const detail = $(`td#cnts_${container}[hasload=True]`);
  const table = detail.find('table.GridView').filter((_, node) => $(node).find('th').first().text().trim() === 'SEQ');
  if (table.length !== 1) {
    throw new IndeterminateError(provider, 'Translink listed the container without a movement grid', { reason: 'listed' });
  }
  const rows = table.children('tbody').children('tr');
  const columns = rows.first().children('th').map((_, node) => $(node).text().trim()).get();
  if (columns.join('|') !== 'SEQ|Event|Place|Date') throw new SchemaError(provider, 'Translink changed its movement columns');

  const scans = rows.slice(1).toArray().flatMap(node => {
    const row = $(node);
    const cells = row.children('td');
    if (cells.length === 1 && cells.first().text().trim().startsWith('* Blue color is the estimated schedule')) return [];
    // The carrier uses blue text for estimated milestones.
    const estimated = row.find('[style],[color]').addBack().toArray().some(element =>
      /(?:^|;|\s)color\s*:\s*(?:blue|#0000ff)\s*(?:;|$)/i.test($(element).attr('style') ?? '')
      || /^(?:blue|#0000ff)$/i.test($(element).attr('color') ?? ''));
    if (estimated) return [];
    const sequence = cells.eq(0).text().trim();
    const description = cells.eq(1).text().trim();
    const location = cells.eq(2).text().trim();
    const clock = cells.eq(3).text().trim();
    const localTime = /^\d{1,2} [A-Za-z]{3} \d{4}$/.test(clock)
      ? DateTime.fromFormat(clock, 'd MMM yyyy', { locale: 'en', zone: 'utc' }).toISODate()
      : null;
    if (cells.length !== columns.length || !/^\d+$/.test(sequence) || !description || !localTime) {
      throw new SchemaError(provider, 'Translink returned an invalid actual movement');
    }
    const stage = scanStage(description);
    return [{
      sequence: Number(sequence), event: {
        local_time: localTime, description, ...(location && { location }),
        ...(stage && { stage, stage_source: 'carrier_map' }),
      },
    }];
  });
  scans.sort((left, right) => right.event.local_time.localeCompare(left.event.local_time) || right.sequence - left.sequence);
  const events = scans.map(({ event }) => event);
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Translink listed the bill without actual movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

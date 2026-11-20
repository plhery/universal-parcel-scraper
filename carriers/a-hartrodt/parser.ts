import { load } from 'cheerio';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { statusMap } from './status.js';

export const PROVIDER = 'a. hartrodt';
export const TRACKING_URL = 'https://ttsecure.hartrodt.com/pserv/tt/open';

interface Reference {
  number: string;
  field: 'job_no' | 'hawb';
}

const JOB = /^[A-Z]{3}\d{16}$/;
const SCAN_CLOCK = /^(\d{4}-\d{2}-\d{2}),\s*((?:[01]\d|2[0-3]):[0-5]\d) GMT(?:([+-])(\d{1,2})(?::([0-5]\d))?)?$/;
const LIMIT = 100;

export function hartrodtReference(input: string): Reference {
  const number = input.trim().toUpperCase();
  if (!/^(?=[A-Z0-9 ./_-]*\d)[A-Z0-9 ./_-]{5,40}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Enter an a. hartrodt house bill or job number');
  }
  return { number, field: JOB.test(number) ? 'job_no' : 'hawb' };
}

export function parseHartrodtSearch(html: string, reference: Reference): string {
  const $ = load(html);
  const results = $('table.pure-table').first();
  if (!results.length) {
    const isMiss = $('title').text().trim() === 'Tracking and Tracing'
      && $('td, b, strong').toArray().some(node => clean($(node).text(), 40) === 'Nothing found');
    if (isMiss) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'a. hartrodt changed the search results');
  }

  const heading = reference.field === 'job_no' ? 'Job No.' : 'HAWB/FBL';
  const headers = results.find('thead th').map((_, cell) => clean($(cell).text(), 40)).get();
  const column = headers.indexOf(heading);
  if (column < 0) throw new SchemaError(PROVIDER, 'a. hartrodt changed the search columns');

  const ids = new Set<string>();
  for (const row of results.find('tbody tr').toArray()) {
    const number = clean($(row).children('td').eq(column).text(), 50).toUpperCase();
    if (number !== reference.number) continue;
    const href = $(row).find('a[href*="view_detail="]').first().attr('href');
    let link: URL;
    try {
      link = new URL(href ?? '', TRACKING_URL);
    } catch {
      throw new SchemaError(PROVIDER, 'a. hartrodt returned an invalid detail link');
    }
    const expected = new URL(TRACKING_URL);
    const id = link.searchParams.get('view_detail');
    if (link.origin !== expected.origin || link.pathname !== expected.pathname || !id || !/^\d{1,18}$/.test(id)) {
      throw new SchemaError(PROVIDER, 'a. hartrodt returned an invalid detail link');
    }
    ids.add(id);
  }

  if (ids.size === 1) return [...ids][0]!;
  if (ids.size > 1) throw new IndeterminateError(PROVIDER, 'a. hartrodt returned multiple jobs for this reference');
  throw new SchemaError(PROVIDER, 'a. hartrodt did not identify the requested reference');
}

export function parseHartrodtDetails(html: string, reference: Reference): CarrierResult {
  const $ = load(html);
  const tables = $('table');
  const shipment = tables.filter((_, table) =>
    clean($(table).find('tr').first().children('td, th').first().text(), 40) === 'Job Number').first();
  const detailColumn = reference.field === 'job_no' ? 0 : 2;
  const echoed = clean(shipment.find('tr').eq(1).children('td').eq(detailColumn).text(), 50).toUpperCase();
  if (echoed !== reference.number) throw new SchemaError(PROVIDER, 'a. hartrodt did not identify the requested shipment');

  const history = tables.filter((_, table) =>
    clean($(table).find('tr').first().children('td, th').first().text(), 40) === 'Date, time').first();
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of history.find('tr').slice(1).toArray()) {
    const cells = $(row).children('td');
    const rawClock = clean(cells.first().text(), 60);
    const description = clean(cells.eq(1).text(), 200);
    if (!rawClock && !description) continue;
    const match = SCAN_CLOCK.exec(rawClock);
    const zone = match?.[3] ? match[3] + match[4]!.padStart(2, '0') + ':' + (match[5] ?? '00') : 'Z';
    const clock = match ? explicitOffsetTime(match[1] + 'T' + match[2] + ':00' + zone) : null;
    if (cells.length !== 2 || !clock || !description) {
      throw new SchemaError(PROVIDER, 'a. hartrodt returned an incomplete or undated event');
    }
    const key = clock.iso + '\0' + description;
    if (seen.has(key)) continue;
    seen.add(key);
    const stage = statusMap.stage(null, normalizeStatusWording(description));
    events.push({ time: clock.iso, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) });
  }

  events.sort((a, b) => Date.parse(b.time!) - Date.parse(a.time!));
  const latest = events[0];
  if (!latest) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description!,
    last_update: latest.time!,
    expected_delivery: null,
    events: events.slice(0, LIMIT),
    ...(events.length > LIMIT ? { history_truncated: true } : {}),
  };
}

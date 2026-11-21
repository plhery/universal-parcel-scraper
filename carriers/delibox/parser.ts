import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { scanStatusMap } from './status.js';

export const PROVIDER = 'Delibox';
const TITLE = '배송진행 상황을 안내드립니다.';
const LOOKUP_ERROR = '잘못된 운송장 번호이거나, 조회 오류가 발생했습니다.';

export function deliboxNumber(raw: string): string {
  const number = raw.trim();
  if (!/^\d{12,13}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Delibox tracking needs a numeric waybill');
  return number;
}

/** The scan table's wall clock, as an ISO time without an offset: the page states no zone. */
function wallClock(text: string): string | null {
  return zonedTime(text, 'yyyy-MM-dd HH:mm', 'UTC')?.iso.slice(0, 19) ?? null;
}

export function parseDelibox(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|cf-challenge|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(html)) {
    throw new ChallengeError(PROVIDER);
  }
  const $ = load(html);
  const title = $('title').text().trim();
  const labels = $('.delivery_info dl').filter((_, label) => $(label).children('dt').text().trim() === '운송장번호');
  if (labels.length === 0 && title === TITLE && $('script').toArray().some(script => $(script).text().includes(`alert("${LOOKUP_ERROR}")`))) {
    // The popup's one alert for an unknown waybill, an expired one and a failed lookup.
    throw new IndeterminateError(PROVIDER, 'Delibox reported an unknown waybill or a lookup error', { reason: 'portal_not_found' });
  }
  if (title !== TITLE || labels.length !== 1 || labels.children('dd').text().trim() !== number) {
    throw new SchemaError(PROVIDER, 'Delibox did not identify the requested waybill');
  }

  const table = $('.delivery_progress_table table');
  const rows = table.children('tbody').children('tr').toArray();
  if (table.length !== 1 || rows.length > 1000) throw new SchemaError(PROVIDER, 'Delibox returned an unreadable history');
  if (rows.length === 0) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });

  const scans = rows.map(row => {
    const cells = $(row).children('td');
    const wall = wallClock(cells.eq(0).text());
    const description = clean(cells.eq(1).text(), 120);
    if (cells.length !== 4 || !wall || !description) throw new SchemaError(PROVIDER, 'Delibox returned an incomplete scan');
    const detail = clean(cells.eq(3).text(), 240);
    const location = /^\[([^\]]+)\]\s+\S/.exec(detail)?.[1];
    const stage = scanStatusMap.stage(null, description);
    const event: CarrierEvent = {
      local_time: wall, description,
      ...(detail ? { original_description: detail } : {}),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return event;
  });
  // The table lists its scans oldest first, so scans of one minute keep the carrier's order once reversed.
  const events = scans.reverse().sort((left, right) => right.local_time!.localeCompare(left.local_time!));

  const stage = leadingScan(events, scanStatusMap)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}

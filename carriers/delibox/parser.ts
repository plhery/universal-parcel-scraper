import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { scanStatusMap } from './status.js';

export const PROVIDER = 'Delibox';
const TITLE = '배송진행 상황을 안내드립니다.';
const LOOKUP_ERROR = '잘못된 운송장 번호이거나, 조회 오류가 발생했습니다.';

export function deliboxNumber(raw: string): string {
  const number = raw.trim();
  if (!/^\d{12,13}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Delibox tracking needs a numeric waybill');
  return number;
}

export function parseDelibox(html: string, number: string): CarrierResult {
  if (/_cf_chl_opt|cf-challenge|cf-error-details|<title>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(html)) {
    throw new ChallengeError(PROVIDER);
  }
  const $ = load(html);
  const title = $('title').text().trim();
  const labels = $('.delivery_info dl').filter((_, label) => $(label).children('dt').text().trim() === '운송장번호');
  if (labels.length === 0 && title === TITLE && $('script').toArray().some(script => $(script).text().includes(`alert("${LOOKUP_ERROR}")`))) {
    throw new IndeterminateError(PROVIDER, 'Delibox reported an unknown waybill or a lookup error');
  }
  if (title !== TITLE || labels.length !== 1 || labels.children('dd').text().trim() !== number) {
    throw new SchemaError(PROVIDER, 'Delibox did not identify the requested waybill');
  }

  const table = $('.delivery_progress_table table');
  const rows = table.children('tbody').children('tr').toArray();
  if (table.length !== 1 || rows.length > 1000) throw new SchemaError(PROVIDER, 'Delibox returned an unreadable history');
  if (rows.length === 0) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });

  const events = rows.map((row, index) => {
    const cells = $(row).children('td');
    const clock = zonedTime(cells.eq(0).text(), 'yyyy-MM-dd HH:mm', 'Asia/Seoul');
    const description = clean(cells.eq(1).text(), 120);
    if (cells.length !== 4 || !clock || !description) throw new SchemaError(PROVIDER, 'Delibox returned an incomplete scan');
    const detail = clean(cells.eq(3).text(), 240);
    const location = /^\[([^\]]+)\]\s+\S/.exec(detail)?.[1];
    const stage = scanStatusMap.stage(null, description);
    const event: CarrierEvent = {
      time: clock.iso, description,
      ...(detail ? { original_description: detail } : {}),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { event, at: clock.timestamp, index };
  }).sort((left, right) => right.at - left.at || right.index - left.index).map(({ event }) => event);

  const lead = leadingScan(events, scanStatusMap);
  const stage = lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description,
    last_update: events[0]!.time,
    expected_delivery: null,
    ...(stage === 'delivered' && lead?.time ? { delivered_at: lead.time } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}

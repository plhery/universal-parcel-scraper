import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { stageForWording } from './status.js';

export const provider = 'intras-jp';

function event(date: string, description: string, location: string): CarrierEvent {
  const time = date.replace(' ', 'T');
  if (!description || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(time) ||
    !DateTime.fromISO(time, { zone: 'utc' }).isValid) {
    throw new SchemaError(provider, 'Invalid INTRAS history row');
  }
  const stage = stageForWording(normalizeStatusWording(description));
  return {
    description, local_time: time.length === 16 ? `${time}:00` : time,
    ...(location ? { location } : {}),
    ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
  };
}

export function parseTracking(html: string, number: string, httpStatus: number): CarrierResult {
  const $ = load(html);
  if (httpStatus === 404 && $('#common-error .message').text().trim() === `'${number}'에 대한 데이타가 없습니다.`) {
    throw new NotFoundError(provider);
  }
  const page = $('#delivery-tracking');
  if (httpStatus !== 200 || page.length !== 1) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
      throw new ChallengeError(provider, 'INTRAS requires verification');
    }
    throw new SchemaError(provider, 'Missing INTRAS tracking results');
  }
  if (page.find('h2').text().trim() !== `House B/L : ${number}`) {
    throw new IndeterminateError(provider, 'INTRAS answered for another house bill');
  }
  const selected = page.find('td.color-blue');
  if (selected.length !== 1) throw new SchemaError(provider, 'Missing INTRAS tracking progress');
  const summary = selected.text().trim();
  const stage = stageForWording(normalizeStatusWording(summary));

  const events: CarrierEvent[] = [];
  const heading = (text: string) => page.find('h3').filter((_, node) => $(node).text().trim().startsWith(text));
  const customs = heading('통관정보').next('table').find('tbody tr').toArray();
  for (const [index, row] of customs.entries()) {
    const columns = $(row).children('td');
    if (!columns.first().is('[rowspan]')) continue;
    const details = $(customs[index + 1]).children('td');
    if (columns.length !== 6 || details.length !== 5) throw new SchemaError(provider, 'Incomplete INTRAS customs entry');
    const date = columns.eq(4).text().trim() || details.first().text().trim();
    events.push(event(date, columns.eq(1).text().trim(), details.eq(1).text().trim()));
  }
  for (const row of heading('국내택배현황').next('table').find('tbody tr').toArray()) {
    const columns = $(row).children('td');
    if (columns.length !== 4) throw new SchemaError(provider, 'Invalid INTRAS domestic tracking row');
    const [day, clock, location, description] = columns.toArray().map(node => $(node).text().trim());
    events.push(event(`${day} ${clock}`, description!, location!));
  }
  events.sort((a, b) => b.local_time!.localeCompare(a.local_time!));
  const latest = events[0];
  if (!stage && !latest) throw new NoHistoryError(provider);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: summary,
    ...(latest ? { last_update_local: latest.local_time } : {}),
    events,
  };
}

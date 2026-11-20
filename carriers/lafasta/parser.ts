import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { stageForWording } from './status.js';

export const provider = 'lafasta';
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const identity = $('h5.text-danger').filter((_, element) => clean($(element).text()).startsWith('رقم التتبع:'));
  if (!identity.length && $('#search-form').length === 1 &&
    clean($('[role="alert"].alert-info').text()) === 'رقم الشحنة غير موجود') {
    throw new NotFoundError(provider);
  }
  if (identity.length !== 1 || $('.tracking-info-row').length !== 1) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
      throw new ChallengeError(provider, 'Lafasta requires verification');
    }
    throw new SchemaError(provider, 'Missing Lafasta tracking results');
  }
  if (clean(identity.text()).toUpperCase() !== `رقم التتبع: ${number}`) {
    throw new IndeterminateError(provider, 'Lafasta answered for another shipment');
  }

  const dateField = $('.form-group').filter((_, element) => clean($(element).children('.gray').text()) === 'تاريخ الشحنة')
    .children('.display-date');
  const options = { zone: 'utc', locale: 'en-US' };
  const shipment = DateTime.fromFormat(clean(dateField.text()), 'yyyy-MM-dd h:mm a', options);
  if (dateField.length !== 1 || !shipment.isValid) throw new SchemaError(provider, 'Missing Lafasta shipment date');
  let lowestDay = shipment.toISODate();
  let year = shipment.year;

  const history = $('.tracking-info-row .nodes .node-container').toArray().reverse().map(element => {
    const row = $(element).find('.node-text');
    const dates = row.children('.time').find('.display-date').map((_, node) => clean($(node).text())).get();
    const content = row.children('div').not('.time');
    const location = clean(content.find('i.fa-map-marker').parent().text());
    const wording = content.clone();
    wording.children().remove();
    const description = clean(wording.text());
    if (dates.length !== 2 || content.length !== 1 || !description) throw new SchemaError(provider, 'Invalid Lafasta history row');

    // The website omits the year of a scan. Read the scans forward from the shipment date.
    const monthAndClock = `${dates[0]} ${dates[1]}`;
    const clockOf = (value: number) => DateTime.fromFormat(`${value} ${monthAndClock}`, 'yyyy MMM, dd h:mm a', options);
    let clock = clockOf(year);
    if (clock.isValid && clock.toISODate() < lowestDay) clock = clockOf(++year);
    if (!clock.isValid) throw new SchemaError(provider, 'Invalid Lafasta scan clock');
    lowestDay = clock.toISODate();
    const stage = stageForWording(normalizeStatusWording(description));
    const event: CarrierEvent = {
      description, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { event, stage };
  }).reverse();
  const newest = history[0]?.event;
  if (!newest) throw new NoHistoryError(provider);
  const stage = history.find(scan => scan.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update_local: newest.local_time, events: history.map(scan => scan.event),
  };
}

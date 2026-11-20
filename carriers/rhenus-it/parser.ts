import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { scanStages } from './status.js';

export const PROVIDER = 'Rhenus Italia';

export function normalizeNumber(raw: string): string {
  const number = raw.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Enter a Rhenus Italia shipment number');
  // The home-delivery lookup requires the printed separator, which the shared input drops.
  return number.replace(/^(\d{9})(\d{2})$/, '$1-$2');
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (/_cf_chl_opt|<title>\s*(?:Just a moment|Access denied|Request rejected)/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'Rhenus Italia returned a browser check');
  }
  const $ = load(body);
  const form = $('#trackingForm');
  const history = form.find('#cd-timeline');
  const unavailable = form.find('label.tt-blue-bold-little').toArray().some(label =>
    /^Il Servizio non .+ al momento disponibile\.$/i.test(clean($(label).text(), 200)));
  if (form.length === 1 && history.length === 0 && unavailable) {
    // Both an unrecognized number and an unavailable tracker can show this screen.
    throw new IndeterminateError(PROVIDER, 'Rhenus Italia says the tracking service is unavailable');
  }
  const id = form.find('span').filter((_, label) => $(label).text().trim() === 'N. spedizione').next('span');
  if (form.length !== 1 || id.length !== 1 || id.text().trim().toUpperCase() !== number || history.length !== 1) {
    throw new SchemaError(PROVIDER, 'Rhenus Italia did not identify the requested shipment');
  }

  const events: CarrierEvent[] = history.find('.cd-timeline-block .cd-timeline-content').toArray().map(row => {
    const content = $(row);
    const description = clean(content.children('.trk-text-bold').text(), 400);
    const date = zonedTime(content.children('.trk-text').text(), 'dd/MM/yyyy HH:mm', 'UTC');
    if (!description || !date) throw new SchemaError(PROVIDER, 'Rhenus Italia returned an incomplete scan');
    const stage = scanStages.stage(null, normalizeStatusWording(description));
    return { local_time: date.iso.slice(0, 19), description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER);
  const leading = leadingScan(events, scanStages);
  const stage = leading?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: (leading ?? newest).description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}

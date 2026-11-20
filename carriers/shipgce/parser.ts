import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { stageForWording } from './status.js';

export const provider = 'shipgce';
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const waybills = $('.searchpk > .hnd > .hnd_info').filter((_, node) => /^Waybill No:/i.test(clean($(node).text())));
  if (!waybills.length) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
      throw new ChallengeError(provider, 'Feiyang GCEx requires verification');
    }
    const missing = $('.searchpk').filter((_, node) => clean($(node).find('.hd h3').text()) === 'Shipment Status');
    if (clean(missing.find('.dbd > .hnd_info').text()) === 'GCEx could not locate the shipment details for you') {
      throw new NotFoundError(provider);
    }
    throw new SchemaError(provider, 'Missing Feiyang GCEx waybill');
  }

  const matching = waybills.filter((_, node) => clean($(node).children('strong').text()).toUpperCase() === number);
  if (matching.length !== 1) throw new IndeterminateError(provider, 'Feiyang GCEx did not return exactly one matching waybill');
  const shipment = matching.closest('.searchpk');
  const timeline = shipment.children('.bd');
  if (timeline.length !== 1) throw new SchemaError(provider, 'Missing Feiyang GCEx scan container');
  const history = timeline.find('.itemaddr > .col');
  if (!history.length) throw new NoHistoryError(provider);

  const events: (CarrierEvent & { stage?: Stage })[] = history.toArray().map(node => {
    const row = $(node);
    const clock = DateTime.fromFormat(clean(row.children('p.time').text()), 'yyyy-MM-dd HH:mm:ss', { zone: 'utc' });
    const description = clean(row.children('p').not('.time').text());
    if (!clock.isValid || !description) throw new SchemaError(provider, 'Invalid Feiyang GCEx scan');
    const stage = stageForWording(description);
    return {
      description, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
  });
  const newest = events[0]!;
  const summary = clean(shipment.find('.hnd > .qiansp > p').text());
  const stage = stageForWording(summary) ?? events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update_local: newest.local_time, events,
  };
}

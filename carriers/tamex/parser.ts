import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { stageOf } from './status.js';

const provider = 'tamex';

export function parseTracking(html: string, number: string, httpStatus: number): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
    throw new ChallengeError(provider, 'Tamex tracker requires verification');
  }
  if (httpStatus !== 200) throw new SchemaError(provider, 'Tamex tracker unavailable');
  const $ = load(html);
  const forms = $('form').filter((_, form) => $(form).attr('action') === 'https://tamex.com.sa/track');
  const headings = $('.card-body > h2.text-center');
  if (forms.length !== 1 || headings.length !== 1) throw new SchemaError(provider, 'Unexpected Tamex tracking page');
  if (headings.text().trim() !== number) throw new IndeterminateError(provider, 'Tamex answered for another shipment');

  const rows = $('.card-body').filter((_, card) => $(card).children('h5.card-title, p.card-text').length > 0);
  if (!rows.length && headings.siblings('p.text-center').text().trim() === 'لايتوفر سجل للشحنة') throw new NotFoundError(provider);
  // Oldest first. The warehouses receive the parcel again in the customer's city, after the sorting: a receipt then
  // moves it on rather than accepting it.
  let moved = false;
  const events = rows.toArray().map(card => {
    const date = $(card).children('h5.card-title');
    const wording = $(card).children('p.card-text');
    const local_time = date.text().trim();
    const description = wording.text().trim();
    if (date.length !== 1 || wording.length !== 1 || !description
        || !/^\d{4}-\d{2}-\d{2}$/.test(local_time) || !DateTime.fromISO(local_time, { zone: 'utc' }).isValid) {
      throw new SchemaError(provider, 'Invalid Tamex history row');
    }
    const mapped = stageOf(description);
    const stage = mapped === 'accepted' && moved ? 'in_transit' : mapped;
    if (stage && stage !== 'registered' && stage !== 'accepted') moved = true;
    return { local_time, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  }).reverse();

  const newest = events[0];
  if (!newest) throw new IndeterminateError(provider, 'Tamex returned no history');
  return {
    status: newest.stage ? languageStageStatus(newest.stage) : 'unknown',
    ...(newest.stage ? { current_stage: newest.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update_local: newest.local_time, events,
  };
}

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { scanStage } from './status.js';

export const provider = 'ethiopian-cargo';

const readableText = (value: string) => value.trim().replace(/\s+/g, ' ');

export function parseTracking(body: string, serial: string): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(body)) {
    throw new ChallengeError(provider, 'Ethiopian Cargo requires verification');
  }
  const $ = load(body);
  const heading = $('h2.shipment-header');
  if (heading.length !== 1 || readableText(heading.text()) !== 'Track your shipment') {
    throw new SchemaError(provider, 'Ethiopian Cargo omitted the tracking page heading');
  }

  const reference = $('h2.awb-no');
  const history = $('h2.shipmet-history').filter((_, node) => readableText($(node).text()) === 'Shipment History')
    .parent().next('.container.alignment');
  const missing = $('.alert.alert-danger').filter((_, node) =>
    readableText($(node).text()) === 'No cargo tracking details found. Please make sure the AWB number is correct.');
  const matchesSerial = reference.length === 1 && readableText(reference.text()) === `AWB No : ${serial}`;
  if (history.length === 0 && missing.length === 1 && (reference.length === 0 || matchesSerial)) {
    throw new NotFoundError(provider);
  }
  if (reference.length !== 1 || history.length !== 1) {
    throw new SchemaError(provider, 'Ethiopian Cargo omitted the air waybill or the shipment history');
  }
  if (!matchesSerial) {
    throw new IndeterminateError(provider, 'Ethiopian Cargo returned a different air waybill');
  }

  const events = history.find('.status-container').toArray().map(node => {
    const label = $(node).find('strong.status-font');
    const name = readableText(label.text());
    const clock = readableText($(node).find('.row > div:last-child > strong').text());
    const date = DateTime.fromFormat(clock, 'dd-MMM-yy HH:mm:ss', { zone: 'utc', locale: 'en' });
    if (label.length !== 1 || !name || !date.isValid) throw new SchemaError(provider, 'Ethiopian Cargo returned an invalid movement');
    const pieces = /^[\d,]+\/[\d,]+ Pcs\b/.exec(readableText(label.next('div').text()))?.[0];
    const stage = scanStage(name);
    return {
      local_time: date.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      description: pieces ? `${name} (${pieces})` : name,
      ...(pieces && { original_description: name }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Ethiopian Cargo listed the air waybill without dated movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.original_description ?? latest.description, last_update_local: latest.local_time, events,
  };
}

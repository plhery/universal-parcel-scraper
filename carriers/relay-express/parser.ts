import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { stageForWording } from './status.js';

export const provider = 'relay-express';
const tidy = (value: string) => value.replace(/\s+/g, ' ').trim();

function parseError(body: string): never {
  let reply: { success?: unknown; message?: unknown; captchaImage?: unknown };
  try {
    reply = JSON.parse(body) as typeof reply;
  } catch (cause) {
    throw new SchemaError(provider, 'Malformed Relay Express error reply', { cause });
  }
  if (reply?.success === false && reply.message === 'Docket number not found.') throw new NotFoundError(provider);
  if (reply?.captchaImage || (typeof reply?.message === 'string' && /captcha/i.test(reply.message))) {
    throw new ChallengeError(provider, 'Relay Express requires verification');
  }
  throw new SchemaError(provider, 'Unexpected Relay Express error reply');
}

export function parseTracking(body: string, number: string): CarrierResult {
  if (body.trimStart().startsWith('{')) parseError(body);
  const $ = load(body);
  const timeline = $('.tracking-timeline');
  if (timeline.length !== 1 || tidy(timeline.find('.timeline-title').text()) !== 'Shipment Journey') {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(body)) {
      throw new ChallengeError(provider, 'Relay Express requires verification');
    }
    throw new SchemaError(provider, 'Missing Relay Express shipment journey');
  }
  // The result is scoped to one docket. When present, the proof label also repeats its entire value.
  const proofNumbers = timeline.find('.timeline-location u').toArray()
    .map(node => /^POD_([A-Z0-9-]+)\.[a-z]+$/i.exec(tidy($(node).text()))?.[1])
    .filter((identity): identity is string => Boolean(identity));
  if (proofNumbers.some(identity => identity.toUpperCase() !== number)) {
    throw new IndeterminateError(provider, 'Relay Express answered for another docket');
  }

  const scans = timeline.find('.timeline-item').toArray().flatMap(element => {
    const row = $(element);
    const description = tidy(row.find('.timeline-status').text());
    const date = tidy(row.find('.timeline-day').text());
    const time = tidy(row.find('.timeline-time').text());
    if (!description && !date && !time && row.find('.timeline-location u').length) return [];
    const clock = DateTime.fromFormat(`${date} ${time}`, 'dd MMM yy hh:mm a', { zone: 'utc', locale: 'en-US' });
    if (!description || !clock.isValid) throw new SchemaError(provider, 'Invalid Relay Express journey row');
    const location = row.find('.timeline-location').toArray().map(node => tidy($(node).text()))
      .find(text => text.startsWith('Location at '))?.slice('Location at '.length);
    const stage = stageForWording(normalizeStatusWording(description));
    const event: CarrierEvent = {
      description, local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return [{ event, stage, timestamp: clock.toMillis() }];
  }).sort((a, b) => b.timestamp - a.timestamp);
  const latest = scans[0]?.event;
  if (!latest) throw new NoHistoryError(provider);
  const stage = scans.find(scan => scan.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description, last_update_local: latest.local_time, events: scans.map(scan => scan.event),
  };
}

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { hasPrivateDeliveryDetails, languageStageStatus, trackingLanguageStage, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { stageForWording } from './status.js';

export const provider = 'fraktjakt';
export const trackingCodePattern = /^[0-9a-f]{32}$/i;

const administrative = /^(?:Receiver notified|Your investigation has been closed with a proof of delivery\.?)$/i;

function clockOf(wording: string): string | undefined {
  const match = /^\p{L}+ (\d{1,2} \p{L}+ \d{4}), at (\d{1,2}:\d{2} [ap]m)(?: \([^)]*\))?$/iu.exec(wording);
  if (!match) return undefined;
  const time = DateTime.fromFormat(`${match[1]} ${match[2]}`, 'd LLLL yyyy h:mm a', { locale: 'en', zone: 'UTC' });
  return time.isValid ? time.toFormat("yyyy-MM-dd'T'HH:mm:ss") : undefined;
}

function placeOf(value: string): string | undefined {
  const country = value.split(',').at(-1)?.trim();
  return countryCode(country) && /^(?:[\p{L} .’'-]+, )*[\p{L} .’'-]+$/u.test(value) &&
    !hasPrivateDeliveryDetails(value) ? value : undefined;
}

export function parseTracking(html: string): CarrierResult {
  const $ = load(html);
  if (/^(?:Just a moment|Access Denied|Verification required)/i.test(clean($('title').text())) ||
    $('form#challenge-form, main .g-recaptcha').length > 0) {
    throw new ChallengeError(provider, 'Fraktjakt returned a verification page');
  }
  const result = $('#result');
  const timelines = result.find('ul.timeline');
  if (result.length !== 1 || result.find('table.shipping_details').length !== 1 || timelines.length > 1) {
    throw new SchemaError(provider, 'Fraktjakt did not return one shipment tracking view');
  }
  const events: (CarrierEvent & { stage?: Stage })[] = timelines.children('li.event').toArray().flatMap(row => {
    const scan = $(row).children('.event_container');
    const wording = clean(scan.children('h3').text(), 180);
    const clock = clockOf(clean(scan.children('.eventdate').text()));
    if (!wording) return [];
    const mapped = stageForWording(wording);
    const stage = administrative.test(wording) ? undefined : mapped ?? trackingLanguageStage(wording);
    const privateWording = hasPrivateDeliveryDetails(wording);
    // Registration rows put the sender account or the partner name in this field.
    const place = stage === 'registered' ? undefined : placeOf(clean($(row).attr('data-location') ?? '', 100));
    if (!clock && privateWording && !stage) return [];
    return [{
      ...(!privateWording ? { description: wording, provider_code: wording } : {}),
      ...(clock ? { local_time: clock } : {}),
      ...(place ? { location: place } : {}),
      ...(stage ? { stage, stage_source: mapped ? 'carrier_map' : 'wording:language' } : {}),
    }];
  });
  if (events.length === 0) throw new NoHistoryError(provider);
  // The portal already orders scans. Local clocks from separate countries are not comparable.
  const current = events.find(event => event.stage) ?? events[0]!;
  const { stage } = current;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    ...(current.provider_code ? { provider_code: current.provider_code } : {}),
    last_status_text: current.description ?? null,
    last_update: null,
    ...(current.local_time ? { last_update_local: current.local_time } : {}),
    events,
  };
}

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { alaskaAirCargoStage, arrivalStages } from './status.js';

export const provider = 'alaska-air-cargo';
export const PREFIX = '027';

// The message the portal sends in a header when it holds no shipment for the waybill it names.
const NOT_FOUND = 'tracking.default.shipmentnotfound';
const AIRPORT = /^[A-Z]{3}$/;
// "Booked at SAN": the step, then the station that wrote it.
const STEP = /^(.+?)\s+at\s+([A-Z]{3})$/;
// "16-Apr 2025 | 11:14", the station's wall clock.
const CLOCK = /^(\d{1,2})-([A-Za-z]{3}) (\d{4}) \| (\d{1,2}):(\d{2})$/;
const MAX_ROWS = 300;

/** Alaska Air Cargo's prefix 027, then an eight-digit serial ending in the first seven digits' remainder by seven. */
export function normalizeAlaskaAirCargoNumber(raw: string): string {
  const [, serial = ''] = /^(?:027[\s-]?)?(\d{8})$/.exec(typeof raw === 'string' ? raw.trim() : '') ?? [];
  if (!serial || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(provider, 'Enter an Alaska Air Cargo air waybill beginning with 027');
  }
  return PREFIX + serial;
}

/** The waybill as the portal writes it, the prefix and serial joined by a hyphen. */
export const shownNumber = (number: string): string => `${number.slice(0, 3)}-${number.slice(3)}`;

interface PortalMessage { code: string; arguments: string[] }

/** The portal's `applicationmessages` header: a JSON list of message codes and the values they name. */
export function portalMessages(header: string | null): PortalMessage[] {
  if (!header) return [];
  let data: unknown;
  try {
    data = JSON.parse(header);
  } catch (cause) {
    throw new SchemaError(provider, 'Alaska Air Cargo returned unreadable portal messages', { cause });
  }
  if (!Array.isArray(data)) throw new SchemaError(provider, 'Alaska Air Cargo returned unreadable portal messages');
  return data.filter(isRecord).map(message => ({
    code: clean(message.code, 200),
    arguments: Array.isArray(message.arguments) ? message.arguments.map(value => clean(value, 100)) : [],
  }));
}

function wallClock(value: string): string | undefined {
  const [, day, month, year, hour, minute] = CLOCK.exec(value) ?? [];
  if (!day || !month) return undefined;
  const parsed = DateTime.fromFormat(`${day}-${month.charAt(0).toUpperCase()}${month.slice(1).toLowerCase()} ${year} ${hour}:${minute}`,
    'd-MMM yyyy H:mm', { locale: 'en', zone: 'UTC' });
  return parsed.isValid ? parsed.toFormat("yyyy-MM-dd'T'HH:mm") : undefined;
}

type Event = CarrierEvent & { description: string; local_time: string };

/**
 * Reads the fragment `trackshipments?fragments=trackPanel` returns. The waybill's tab carries the
 * latest status of its pieces at each station and the history, the oldest row first, each on the
 * clock of the station that wrote it. A waybill the portal does not hold comes back without a tab,
 * with a not-found message naming it in the `applicationmessages` header.
 */
export function parseAlaskaAirCargo(html: string, messagesHeader: string | null, number: string): CarrierResult {
  const shown = shownNumber(number);
  const messages = portalMessages(messagesHeader);
  const $ = load(html);
  const tabs = $('#trackingInfoDetails .tab-pane');
  const tab = tabs.filter((_, element) => $(element).attr('id') === shown).first();
  if (!tab.length) {
    const missing = messages.find(message => message.code === NOT_FOUND);
    if (missing?.arguments.includes(shown)) throw new NotFoundError(provider);
    if (missing || tabs.length) throw new IndeterminateError(provider, 'Alaska Air Cargo answered for another air waybill');
    throw new SchemaError(provider, 'Alaska Air Cargo returned neither the waybill nor a not-found message');
  }

  // "SAN>PHL" on the waybill's tab: the notice and delivery belong at the second station.
  const route = clean($('#trkShpTabs a').filter((_, element) => $(element).attr('href') === `#${shown}`).find('.fligh-way-tab').text(), 20);
  const destination = /^[A-Z]{3}\s*>\s*([A-Z]{3})$/.exec(route)?.[1] ?? '';

  const rows = tab.find('.flightList').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, 'Alaska Air Cargo returned an unexpectedly long history');
  const listed: Event[] = rows.map(row => {
    const [step = '', clock = ''] = $(row).find('h5').toArray().map(cell => clean($(cell).text(), 200));
    const [, wording = step, station = ''] = STEP.exec(step) ?? [];
    const local_time = wallClock(clock);
    if (!wording || !local_time) throw new SchemaError(provider, 'Alaska Air Cargo returned an incomplete history row');
    let stage = alaskaAirCargoStage(wording);
    // A notice or a delivery away from the destination is a step on the way.
    if (stage && arrivalStages.has(stage) && destination && station && station !== destination) stage = 'in_transit';
    return {
      description: wording, local_time,
      ...(station && { location: station, original_description: step }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  });
  const seen = new Set<string>();
  // Each station writes on its own clock, so the tracker's order is the history's order.
  const events = listed.reverse().filter(event => {
    const key = JSON.stringify([event.description, event.local_time, event.location]);
    return !seen.has(key) && Boolean(seen.add(key));
  });
  if (!events.length) throw new NoHistoryError(provider, 'Alaska Air Cargo lists the air waybill without history', { reason: 'listed' });

  // The tracker's latest status of the pieces at each station: "PHL: 1 PCS in Notified status".
  const latest = tab.find('.panel-heading.LATEST').closest('.panel').find('ul.feeds > li').toArray().map(item => ({
    station: clean($(item).find('.cont-col1 .label').text(), 10),
    wording: clean($(item).find('.cont-col2 .desc .label').text(), 200).toLowerCase(),
  })).filter(item => item.wording);
  const named = events.findIndex(event => latest.some(item => item.wording === event.description.toLowerCase()
    && (!AIRPORT.test(item.station) || item.station === event.location)));
  // A row recorded after the delivery does not take it back; a step without a stage keeps the one before it.
  const current = events.find(event => event.stage === 'delivered')
    ?? (named >= 0 ? events.slice(named).find(event => event.stage) : undefined)
    ?? events.find(event => event.stage) ?? events[0]!;
  const stage = current.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: current.description,
    last_update: null,
    last_update_local: current.local_time,
    events,
  };
}

import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { DateTime } from 'luxon';
import { hasMod7CheckDigit } from '../../core/detection/numericChecksums.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { kalittaAirStage } from './status.js';

export const provider = 'kalitta-air';
export const PREFIX = '272';

/** The clock the adapter asks the tracker to show the dates it converts in. */
export const USER_ZONE = 'UTC';
const USER_CLOCK = 'Timezone: Coordinated Universal Time';
const STATION_CLOCK = 'Local timezone';
const verification = /<title>\s*(?:Access Denied|Just a moment|Attention Required)|cf-chl|_Incapsula_Resource|\/_sec\/cp_challenge/i;
const MAX_ROWS = 500;

/** Kalitta Air's prefix 272, then an eight-digit serial ending in the first seven digits' remainder by seven. */
export function normalizeKalittaAirNumber(raw: string): string {
  // Waybills are written 272-73471845, 272 7347 1845 or without the prefix.
  const [, serial = ''] = /^(?:272)?(\d{8})$/.exec(typeof raw === 'string' ? raw.replace(/[\s-]/g, '') : '') ?? [];
  if (!serial || !hasMod7CheckDigit(serial)) {
    throw new InvalidInputError(provider, 'Enter a Kalitta Air air waybill beginning with 272');
  }
  return PREFIX + serial;
}

/** The waybill as the tracker's form takes and shows it, 272-73471845. */
export const formNumber = (number: string): string => `${number.slice(0, 3)}-${number.slice(3)}`;

/** 16 OCT 2023 0:30: a station's wall clock, or a time the tracker converted to the visitor's zone. */
function clockOf(title: string, value: string): Pick<CarrierEvent, 'time' | 'local_time'> {
  if (title === STATION_CLOCK) {
    const wall = DateTime.fromFormat(value, 'd MMM yyyy H:mm', { zone: 'UTC', locale: 'en' });
    if (wall.isValid) return { local_time: wall.toFormat("yyyy-MM-dd'T'HH:mm") };
  } else if (title === USER_CLOCK) {
    const instant = zonedTime(value, 'dd MMM yyyy HH:mm', USER_ZONE, { locale: 'en' });
    if (instant) return { time: instant.iso };
  } else {
    throw new SchemaError(provider, 'Kalitta Air dated a status in a zone the adapter did not ask for');
  }
  throw new SchemaError(provider, 'Kalitta Air returned an unreadable status date');
}

/** The airport a row names: "… at ANC on 16OCT, 12:24", or a manifest's leg, "… on flight K4925, TAO-ICN". */
function stationOf(description: string): string {
  const at = [...description.matchAll(/\bat ([A-Z]{3}) on \d/g)].at(-1)?.[1];
  return at ?? /\bon flight [A-Z0-9]{2}\d{1,5}[A-Z]?, ([A-Z]{3})-[A-Z]{3}$/.exec(description)?.[1] ?? '';
}

function readEvent($: CheerioAPI, row: Element, destination: string): CarrierEvent {
  const cells = $(row).children('td');
  const date = cells.eq(0).find('span').first();
  const description = clean(cells.eq(1).text());
  if (cells.length < 2 || !date.length || !description) throw new SchemaError(provider, 'Kalitta Air returned an incomplete status');
  const clock = clockOf(clean(date.attr('title')), clean(date.text(), 40));
  const code = clean($(row).attr('class'), 40);
  const station = stationOf(description);
  const stage = /^[a-z]+$/.test(code) ? kalittaAirStage(code, description, station !== '' && station === destination) : undefined;
  return {
    description, ...clock,
    ...(/^[a-z]+$/.test(code) && { provider_code: code }),
    ...(station && { location: station }),
    ...(stage && { stage, stage_source: 'carrier_map' }),
  };
}

/** The value beside a label of the waybill's details, such as Destination. */
function detail($: CheerioAPI, panel: Cheerio<Element>, label: string): string {
  const pair = panel.find('.fvp').toArray().find(node => clean($(node).children('.fn').text()) === label);
  return pair ? clean($(pair).children('.fv').text(), 100) : '';
}

/** The tracker's page for one searched waybill, checked against the requested one. */
export function parseKalittaAirTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const panels = $('.TTPanel').toArray().map(node => ({
    panel: $(node),
    title: clean($(node).children('.TTPanel-header').children('.TTPanel-header-title').text(), 200),
  }));
  const waybills = panels.flatMap(({ panel, title }) => {
    const [, prefix = '', serial = ''] = /^Air Waybill no:\s*(\d{3})-?(\d{8})$/i.exec(title) ?? [];
    return prefix ? [{ panel, shown: prefix + serial }] : [];
  });
  if (!waybills.length) {
    if (verification.test(html)) throw new ChallengeError(provider, 'Kalitta Air returned a verification page');
    throw new SchemaError(provider, 'Kalitta Air returned no air waybill');
  }
  const waybill = waybills.find(entry => entry.shown === number)?.panel;
  if (!waybill) throw new IndeterminateError(provider, 'Kalitta Air returned another air waybill');
  if (clean(waybill.find('h2').first().text()) === 'Air Waybill not found') throw new NotFoundError(provider);
  if (waybill.attr('id') !== 'AWB-Details') throw new SchemaError(provider, 'Kalitta Air returned the air waybill without its details');

  const destination = detail($, waybill, 'Destination').toUpperCase();
  const history = panels.find(({ title }) => title === 'Status updates')?.panel;
  const rows = history?.find('tr').toArray().filter(row => $(row).children('td').length > 0) ?? [];
  if (!rows.length) throw new NoHistoryError(provider, 'Kalitta Air lists the air waybill without a status', { reason: 'listed' });
  if (rows.length > MAX_ROWS) throw new SchemaError(provider, 'Kalitta Air returned too many statuses');

  // Each station writes its own clock, and the tracker converts only its own messages, so its order is the history's.
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const event = readEvent($, row, destination);
    const key = JSON.stringify([event.provider_code, event.description, event.time, event.local_time]);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  const current = events[0]!;
  const stage = current.stage as ReturnType<typeof kalittaAirStage>;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: current.description ?? null,
    ...(current.provider_code && { provider_code: current.provider_code }),
    last_update: current.time ?? null,
    ...(current.local_time && { last_update_local: current.local_time }),
    events,
  };
}

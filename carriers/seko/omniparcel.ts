import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { NoHistoryError, NotFoundError, SchemaError, IndeterminateError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { pageText } from './parser.js';
import { OMNIPARCEL_NUMBER } from './clock.js';
import { sekoStage } from './status.js';

export const OMNIPARCEL_PROVIDER = 'SEKO OmniParcel';
/** OmniParcel's tracker, which its server renders for the number in `?Id=`. */
export const OMNIPARCEL_PAGE = 'https://track.omniparcel.com/';
/** The tracker's id for Coordinated Universal Time in its time zone list, so its clocks are instants. */
export const OMNIPARCEL_UTC = '91';
// The page is about 110 kB, most of it the time zone list and scripts.
export const OMNIPARCEL_MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 500;
const MAX_EVENTS = 100;
const HEADING = /<h3>\s*Tracking:([\s\S]*?)<\/h3>/;
const TRACKING_ID = /<input id="TrackingId" name="TrackingId" type="hidden" value="([^"]*)"/;
// The tracker's form with nothing found, the same as its home page.
const SEARCH = /Please enter the tracking number you want to search/;
const SELECTED_ZONE = /<option selected="selected" value="(\d+)">/;
const DESTINATION = /Delivery date:\s*<br \/>\s*<strong>[^<]*<\/strong>\s*<br \/>([^<]*)</;
/** The table of a parcel's scans, which a browser check never has. */
export const OMNIPARCEL_HISTORY = '<tbody id="detail1">';
const HISTORY = /<tbody id="detail1">([\s\S]*?)<\/tbody>/;
const ROW = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/g;
const CELL = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
const SUMMARY_FIELD = /<div class="col-md-3"><strong>([^<]*)<\/strong><\/div>\s*<div class="col-md-3">([^<]*)<\/div>/g;
const TWELVE_HOUR = /^(?:0?[1-9]|1[0-2]):[0-5]\d [AP]M$/;

/** Whether a SEKO number is one of OmniParcel's, which only its own tracker answers. */
export const isOmniParcelNumber = (number: string): boolean => OMNIPARCEL_NUMBER.test(number);

/** The page asking the tracker for the number, with its clocks in UTC. */
export const omniParcelUrl = (number: string): string =>
  `${OMNIPARCEL_PAGE}?Id=${encodeURIComponent(number)}&timezoneId=${OMNIPARCEL_UTC}`;

/** A row's instant: the day heading above it and its time, both in the zone the page was asked for. */
function instant(day: string, time: string): string {
  const read = DateTime.fromFormat(`${day} ${time}`, 'cccc, LLLL d, yyyy h:mm a', { zone: 'UTC', locale: 'en-US' });
  // Luxon takes 13:05 PM as 13:05.
  if (!read.isValid || !TWELVE_HOUR.test(time)) throw new SchemaError(OMNIPARCEL_PROVIDER, 'OmniParcel returned an invalid scan time');
  return read.toISO({ suppressMilliseconds: true });
}

function project(day: string | null, cells: string[]): CarrierEvent {
  if (cells.length !== 5 || day === null) throw new SchemaError(OMNIPARCEL_PROVIDER, 'OmniParcel returned an invalid scan');
  const [, time, description, location] = cells.map((cell) => pageText(cell)) as [string, string, string, string, string];
  if (!description) throw new SchemaError(OMNIPARCEL_PROVIDER, 'OmniParcel returned a scan without wording');
  const staged = sekoStage(description);
  return {
    time: instant(day, time),
    description,
    ...(location ? { location: location.replace(/\s*,\s*/g, ', ') } : {}),
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
}

/**
 * OmniParcel's tracking page for `?Id={number}&timezoneId=91`, rendered on its
 * server: the parcel's ship and delivery headings, a step rail, its scans newest
 * first under day headings in UTC, and a summary; or its search form, with
 * nothing found.
 */
export function parseOmniParcelPage(page: string, number: string): CarrierResult {
  const heading = HEADING.exec(page);
  if (!heading) {
    if (SEARCH.test(page)) throw new NotFoundError(OMNIPARCEL_PROVIDER);
    throw new SchemaError(OMNIPARCEL_PROVIDER, 'OmniParcel returned a page without a parcel or its search form');
  }
  const shown = normalizeTrackingNumber(pageText(heading[1]!, 64));
  const asked = TRACKING_ID.exec(page)?.[1];
  if (shown !== number || asked === undefined || normalizeTrackingNumber(asked) !== number) {
    throw new IndeterminateError(OMNIPARCEL_PROVIDER, 'OmniParcel answered for another parcel');
  }
  // The clocks follow the zone the page shows selected; anything but UTC would misplace every scan.
  if (SELECTED_ZONE.exec(page)?.[1] !== OMNIPARCEL_UTC) throw new SchemaError(OMNIPARCEL_PROVIDER, 'OmniParcel shows its clocks in another zone');

  const table = HISTORY.exec(page);
  if (!table) throw new SchemaError(OMNIPARCEL_PROVIDER, 'OmniParcel returned a page without its travel history');
  const rows = [...table[1]!.matchAll(ROW)];
  if (rows.length > MAX_ROWS) throw new SchemaError(OMNIPARCEL_PROVIDER, 'OmniParcel returned an oversized history');
  const events: CarrierEvent[] = [];
  let day: string | null = null;
  for (const [, attributes, row] of rows) {
    const cells = [...row!.matchAll(CELL)].map((cell) => cell[1]!);
    // Each scan is followed by a hidden line naming the parcel it is for; a day heading spans the table.
    if (/\bdetaillinesRow\b/.test(attributes!)) continue;
    if (cells.length === 1) {
      day = pageText(cells[0]!, 80);
      continue;
    }
    events.push(project(day, cells));
  }
  // The page lists the newest first; equal instants keep its order.
  const newestFirst = events.map((event, index) => ({ event, index }))
    .sort((left, right) => Date.parse(right.event.time as string) - Date.parse(left.event.time as string) || left.index - right.index)
    .map(({ event }) => event);
  const newest = newestFirst[0];
  if (!newest) throw new NoHistoryError(OMNIPARCEL_PROVIDER);

  // The step rail is not read: the scans name each step it shows.
  const current = newestFirst.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const summary = new Map([...page.matchAll(SUMMARY_FIELD)].map(([, label, value]) => [pageText(label!, 80).toLowerCase(), pageText(value!, 120)]));
  const service = summary.get('service') ?? '';
  const weight = /^(\d{1,4}(?:\.\d{1,3})?) kg$/i.exec(summary.get('total weight') ?? '')?.[1];
  const destination = countryCode(/\b([A-Z]{2})$/.exec(pageText(DESTINATION.exec(page)?.[1] ?? '', 80))?.[1]);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time,
    // The delivery heading's clock is not the scans' zone, so no expected or delivery time is read from it.
    expected_delivery: null,
    ...(service ? { service_name: service } : {}),
    ...(weight && Number(weight) > 0 ? { weight_kg: Number(weight) } : {}),
    ...(destination ? { destination_country: destination } : {}),
    events: newestFirst.slice(0, MAX_EVENTS),
    ...(newestFirst.length > MAX_EVENTS ? { history_truncated: true } : {}),
  };
}

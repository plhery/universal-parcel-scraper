import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { daytonaStage } from './status.js';

export const PROVIDER = 'daytona-express';
// A reply is under twenty kilobytes; the cap leaves room for a long history.
export const DAYTONA_MAX_BYTES = 512 * 1024;
/** The page the tracking form on the carrier's site opens, with the protocol as `txtcto`. */
export const DAYTONA_TRACKER = 'https://daytonaonline.daytonaexpress.com.br/Conhecimento_daytona/Index';

// The protocol (HAWB) printed on the pickup and delivery documents: nine digits. Customers quote it as "HAWB - 572...".
const PROTOCOL = /^(?:HAWB)?(\d{9})$/;
// "29/10/2024" and "10:30": a scan's wall clock at its base, without an offset.
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
// "JOINVILLE / SC": the base's town and state.
const PLACE = /^(\S.{0,80}?)\s*\/\s*([A-Z]{2})$/;
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden)|_cf_chl_opt|cf-turnstile|The request is blocked/i;
const NOT_FOUND = /Nosso sistema não localizou a encomenda/;
const MAX_ROWS = 200;

/** The protocol as the tracker takes it. */
export function normalizeDaytonaNumber(raw: string): string {
  const typed = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s.:/-]/g, '') : '';
  const protocol = PROTOCOL.exec(typed)?.[1];
  if (!protocol) throw new InvalidInputError(PROVIDER, 'Enter the nine-digit Daytona Express protocol (HAWB)');
  return protocol;
}

export const daytonaUrl = (protocol: string): string => `${DAYTONA_TRACKER}?txtcto=${protocol}`;

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function wallClock(day: string, time: string): string {
  const date = DAY.exec(day);
  const clock = CLOCK.exec(time);
  const iso = date && calendarDay(Number(date[3]), Number(date[2]), Number(date[1]));
  if (!date || !iso || !clock || Number(date[3]) < 2001) return invalid('Daytona Express returned an invalid scan time');
  return `${iso}T${clock[1]}:${clock[2]}:00`;
}

/**
 * Reads the tracker's page for one protocol: its scans, the newest first, at their base's wall
 * clock. Whoever signed for the parcel stays behind.
 */
export function parseDaytona(html: string, protocol: string): CarrierResult {
  if (BLOCKED.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Daytona Express refused the tracking page');
  const $ = load(html);
  // The page writes the number it looked up back into its search field.
  const field = $('input#nr_hawb');
  if (field.length !== 1) return invalid('Daytona Express returned a page without its tracker');
  const asked = clean(field.attr('value'), 64);
  const headings = $('h3.rastreamento_detalhes').map((_index, element) => clean($(element).text(), 120)).get();
  const shipments = headings.filter(heading => heading.startsWith('Detalhes'));
  if (!shipments.length) {
    if (headings.length === 1 && NOT_FOUND.test(headings[0]!)) {
      if (asked !== protocol) throw new IndeterminateError(PROVIDER, 'Daytona Express answered for another protocol');
      throw new NotFoundError(PROVIDER, 'Daytona Express has no shipment under this protocol');
    }
    return invalid('Daytona Express returned no tracking result');
  }
  // The tracker also finds a shipment by its invoice number, which other senders reuse.
  if (shipments.length !== 1 || shipments[0] !== `Detalhes - HAWB - ${protocol}`) {
    throw new IndeterminateError(PROVIDER, 'Daytona Express answered for another protocol');
  }

  const rows = $('tr.textoinformativo').filter((_index, row) => $(row).children('td').length === 4);
  if (rows.length > MAX_ROWS) return invalid('Daytona Express returned too many scans');
  const events = rows.map((index, row): { index: number; event: CarrierEvent & { local_time: string } } => {
    const [day, time, place, wording] = $(row).children('td').map((_cell, cell) => clean($(cell).text(), 200)).get();
    if (!wording) return invalid('Daytona Express returned a scan without wording');
    const town = PLACE.exec(place ?? '');
    const stage = daytonaStage(wording);
    return { index, event: { local_time: wallClock(day ?? '', time ?? ''), description: wording,
      ...(town ? { location: `${town[1]}, ${town[2]}` } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } };
  }).get()
    // The page lists the newest first; scans at one minute keep its order.
    .sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index)
    .map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'Daytona Express lists the protocol without scans', { reason: 'listed' });

  const newest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description!, last_update: null, last_update_local: newest.local_time,
    expected_delivery: null, events,
  };
}

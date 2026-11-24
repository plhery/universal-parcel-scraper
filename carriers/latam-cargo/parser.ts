import { load } from 'cheerio';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { latamStage } from './status.js';

export const PROVIDER = 'latam-cargo';
/** The read LATAM Cargo's tracking page makes for one document: its prefix, serial and type as JSON. */
export const LATAM_LOOKUP = 'https://www.latamcargo.com/en/doTrackShipmentsAction';
// A shipment's reply is about 30 KB.
export const LATAM_MAX_BYTES = 512 * 1024;
/** International air waybills, then Brazilian domestic service orders: the page's two document types. */
export const LATAM_DOCUMENT_TYPES = ['MAWB', 'SO'] as const;
export type LatamDocumentType = (typeof LATAM_DOCUMENT_TYPES)[number];

// A three-digit airline prefix and an eight-digit serial, as the page's two fields take them.
const NUMBER = /^(\d{3})(\d{8})$/;
// A firewall's, CDN's or bot check's page in place of the lookup's reply.
const BLOCKED = /<title>\s*(?:Just a moment|Attention Required|Access Denied|Request Rejected|403 Forbidden|ERROR: The request could not be satisfied)|_cf_chl_opt|cf-turnstile|challenge-platform/i;
// The lookup's whole answer for a document it does not know.
const NOT_FOUND = /^No result found for the given input\. Please check your input value correctness and try again\.$/;
// "26-Jul-2024 18:24": the station's wall clock, without a zone.
const CLOCK = /^(\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{4}) ([01]\d|2[0-3]):([0-5]\d)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "1 / 21.75KGS": the pieces and weight a row covers.
const PIECES = /^(\d{1,5})\s*\/\s*[\d.,]+\s*KGS?$/i;
const STATION = /^[A-Z]{3}$/;
const REQUIRED_HEADINGS = ['Event', 'Description', 'Station', 'Actual P/K', 'Actual Time'];

export interface LatamWaybill { prefix: string; serial: string; label: string }

/** An air waybill or service order as the tracker takes it: three-digit prefix and eight-digit serial. */
export function normalizeLatamNumber(raw: string): LatamWaybill {
  const compact = typeof raw === 'string' && raw.length <= 40 ? raw.replace(/[\s.-]/g, '') : '';
  const match = NUMBER.exec(compact);
  if (!match) throw new InvalidInputError(PROVIDER, 'LATAM Cargo numbers are a three-digit prefix and an eight-digit serial');
  return { prefix: match[1]!, serial: match[2]!, label: `${match[1]}-${match[2]}` };
}

/** Whether a reply is a block page instead of the lookup's HTML. */
export function isLatamBlocked(body: string): boolean {
  return BLOCKED.test(body.slice(0, 64_000));
}

/** Whether the reply is the lookup's own answer that it knows no such document. */
export function isLatamNotFound(body: string): boolean {
  const page = load(body);
  const alerts = page('.alert');
  return alerts.length === 1 && NOT_FOUND.test(clean(alerts.text())) && !page('#statusTable').length;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function wallClock(value: string): string | null {
  const match = CLOCK.exec(value);
  if (!match) return null;
  const day = calendarDay(Number(match[3]), MONTHS.indexOf(match[2]!) + 1, Number(match[1]));
  return day ? `${day}T${match[4]}:${match[5]}` : null;
}

type Movement = CarrierEvent & { local_time: string; description: string; provider_code: string; staged: ClassifiedWording | null; pieces: number | null };

/**
 * The tracking tab for one document: its number and route, the shipment's origin, destination and
 * pieces, and the "Event and Milestone Details" table, newest first, each row with its Cargo-IMP
 * code, description, station, flight, pieces and the station's wall clock. The table's last
 * column names who received a delivery; it is never read. The tab must name the document asked.
 */
export function parseLatam(body: string, rawNumber: string): CarrierResult {
  const { label } = normalizeLatamNumber(rawNumber);
  const page = load(body);
  const heading = clean(page('#nav-tracking p.txt-bold').first().text());
  if (!heading) return invalid('LATAM Cargo returned a reply without its tracking tab');
  if (heading.split(' ')[0] !== label) throw new IndeterminateError(PROVIDER, 'LATAM Cargo answered for another document');
  const table = page('#statusTable');
  if (table.length !== 1) return invalid('LATAM Cargo omitted the event table');
  const headings = table.find('thead th').toArray().map((cell) => clean(page(cell).text()));
  if (!REQUIRED_HEADINGS.every((name) => headings.includes(name))) return invalid('LATAM Cargo changed the event table');
  const column = (name: string) => headings.indexOf(name);
  const destination = clean(page('#shipment_destination').text());
  const total = Number(clean(page('#totalPieces').text()));

  const movements: Movement[] = [];
  for (const row of table.find('tbody tr').toArray()) {
    const cells = page(row).children('td');
    const read = (name: string) => clean(cells.eq(column(name)).text(), 200);
    const code = read('Event');
    const description = read('Description');
    const local = wallClock(read('Actual Time'));
    if (!code || !description || !local) return invalid('LATAM Cargo returned an event without its code, description or time');
    const station = read('Station');
    const pieces = PIECES.exec(read('Actual P/K'));
    movements.push({
      local_time: local, description, provider_code: code, staged: latamStage(code, description),
      ...(STATION.test(station) ? { location: station } : {}), pieces: pieces ? Number(pieces[1]) : null,
    });
  }
  if (!movements.length) throw new NoHistoryError(PROVIDER, 'LATAM Cargo lists the document without events', { reason: 'listed' });

  // A delivery row can cover part of a split shipment: the shipment is delivered once the delivery
  // rows at its destination add up to its pieces. Until then they read as transit.
  const deliveries = movements.filter((event) => event.provider_code === 'DLV' && event.location === destination);
  const delivered = deliveries.reduce((sum, event) => sum + (event.pieces ?? 0), 0);
  const complete = Number.isSafeInteger(total) && total > 0 && delivered >= total;
  type Staged = CarrierEvent & { local_time: string; description: string; stage?: Stage; stage_source?: string };
  const events: Staged[] = movements.map(({ staged, local_time, description, provider_code, location }) => {
    const stage: Stage | undefined = staged?.stage === 'delivered' && !complete ? 'in_transit' : staged?.stage;
    return {
      local_time, description, provider_code, ...(location ? { location } : {}),
      ...(stage && staged ? { stage, stage_source: staged.source } : {}),
    };
  });
  // The table lists the newest first, but a flight's departure can be filed after the delivery it
  // led to: a complete delivery is the current status whatever follows it.
  const current = (complete ? events.find((event) => event.stage === 'delivered') : undefined) ?? events[0]!;
  const { stage } = current;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && current.stage_source ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: current.description,
    last_update: null,
    last_update_local: current.local_time,
    events,
  };
}

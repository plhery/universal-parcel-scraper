import { detectCarrierMatch } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type ClassifiedWording } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { pantosStage } from './status.js';

export const PROVIDER = 'LX Pantos';
export const PANTOS_MAX_BYTES = 256_000;
const ACTION = 'https://www.epantos.com/eCommerce/action/portal.TrackingPopup';
/** The tracking page's search: the shipments a house bill, master bill or delivering courier's number names. */
export const PANTOS_LIST_URL = `${ACTION}.retreiveTrackingList`;
/** A shipment's scans, newest first. */
export const PANTOS_DETAIL_URL = `${ACTION}.retreiveTrackingListDtl`;
export const PANTOS_PAGE = 'https://www.epantos.com/ecp/web/pr/dt/popup/dlvChaseInqPopup.do?locale=en';
const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied|request rejected/i;
const CLOCK = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/;
const MAX_ROWS = 30;
const MAX_SCANS = 200;
// The page's courier codes for the Korean carrier that delivers the parcel under its own number.
const COURIERS: Readonly<Record<string, string>> = { K: 'cj-logistics', H: 'hanjin', E: 'korea-post', V: 'today-kr' };

/** The tracker takes several numbers at once, split by commas, so one number is letters and digits only. */
export function normalizePantosNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.replace(/[\s-]+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{6,30}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

/** The body of a reply the service marks successful; its rate limit is an HTTP 429 the transport keeps. */
export function pantosBody(body: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, `${PROVIDER} answered with a verification page`, { cause });
    throw new SchemaError(PROVIDER, `${PROVIDER} answered with a page instead of its tracking JSON`, { cause });
  }
  if (!isRecord(payload) || !isRecord(payload.header)) throw unreadable('reply');
  if (payload.header.type !== 'SUCCESS') {
    throw new IndeterminateError(PROVIDER, `${PROVIDER} refused the lookup: ${clean(payload.header.message, 160) || 'no reason given'}`);
  }
  return payload.body;
}

const unreadable = (what: string) => new SchemaError(PROVIDER, `${PROVIDER} returned an unreadable ${what}`);

export interface PantosShipment {
  hblNo: string;
  mblNo: string;
  expsBizTypeCd: string;
  carrSprCd?: string;
  wmDomCarr?: string;
  row: Record<string, unknown>;
}

const text = (value: unknown, max = 60) => (typeof value === 'string' ? clean(value, max) : '');

/**
 * The shipment the number names among the search's rows: its house bill, else the delivering
 * courier's number. A master bill names every shipment it consolidates, so it binds only alone.
 */
export function pantosShipment(body: unknown, rawNumber: string): PantosShipment {
  const number = normalizePantosNumber(rawNumber);
  if (!isRecord(body) || !Array.isArray(body.list) || body.list.length > MAX_ROWS) throw unreadable('search');
  const rows = body.list.map(row => {
    if (!isRecord(row) || !text(row.hblNo)) throw unreadable('shipment');
    return row;
  });
  if (!rows.length) throw new NotFoundError(PROVIDER);
  const ours = (row: Record<string, unknown>) => text(row.hblNo).toUpperCase() === number
    || text(row.refBlNoList, 400).toUpperCase().split(',').map(part => part.trim()).includes(number)
    || text(row.refBlNo).toUpperCase() === number;
  const matches = rows.filter(ours);
  let row = matches.length === 1 ? matches[0] : undefined;
  if (!row && !matches.length && rows.every(each => text(each.mblNo).toUpperCase() === number)) {
    if (rows.length > 1) throw new IndeterminateError(PROVIDER, `${PROVIDER} lists ${rows.length} shipments under this master bill`);
    row = rows[0];
  }
  if (!row) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
  const optional = (value: unknown) => text(value) || undefined;
  return {
    hblNo: text(row.hblNo), mblNo: text(row.mblNo), expsBizTypeCd: text(row.expsBizTypeCd),
    carrSprCd: optional(row.carrSprCd), wmDomCarr: optional(row.wmDomCarr), row,
  };
}

/** The detail request the tracking page sends for a shipment it lists. */
export function pantosDetailRequest(shipment: PantosShipment): Record<string, string> {
  return {
    hblNo: shipment.hblNo, mblNo: shipment.mblNo, locale: 'en', expsBizTypeCd: shipment.expsBizTypeCd,
    ...(shipment.carrSprCd ? { carrSprCd: shipment.carrSprCd } : {}),
    ...(shipment.wmDomCarr ? { wmDomCarr: shipment.wmDomCarr } : {}),
  };
}

/** A `YYYYMMDDHHMM` clock as a wall clock. */
function clock(value: unknown): string {
  const match = typeof value === 'string' ? CLOCK.exec(value) : null;
  if (!match) throw unreadable('scan clock');
  const local = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00`;
  const date = new Date(`${local}Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== local) throw unreadable('scan clock');
  return local;
}

interface Scan { index: number; event: CarrierEvent & { local_time: string }; classified: ClassifiedWording | null }

/**
 * The shipment's scans, each on the wall clock of the country it names, newest first. The search's
 * row gives the recipient's romanized name, the destination and the courier that delivers it.
 */
export function parsePantos(shipment: PantosShipment, detail: unknown): CarrierResult {
  if (!Array.isArray(detail) || detail.length > MAX_SCANS) throw unreadable('history');
  const scans: Scan[] = detail.map((row, index) => {
    if (!isRecord(row)) throw unreadable('scan');
    if (text(row.hblNo) !== shipment.hblNo) throw new SchemaError(PROVIDER, `${PROVIDER} answered for another number`);
    const code = text(row.evntCd, 12);
    const wording = text(row.evntDesc, 160);
    if (!code || !wording) throw unreadable('scan');
    const location = text(row.evntLocNm, 80);
    const classified = pantosStage(code, wording);
    return { index, classified, event: {
      local_time: clock(row.eventDt),
      description: wording,
      provider_code: code,
      ...(location ? { location } : {}),
      ...(classified ? { stage: classified.stage, stage_source: classified.source } : {}),
    } };
  });
  if (!scans.length) throw new NoHistoryError(PROVIDER, `${PROVIDER} lists the shipment without a scan`, { reason: 'listed' });
  // Newest first; the service's order settles scans of one minute.
  scans.sort((left, right) => right.event.local_time.localeCompare(left.event.local_time) || left.index - right.index);
  const newest = scans[0]!;
  const current = scans.find(scan => scan.classified)?.classified;
  const row = shipment.row;
  const recipient = text(row.cneeNm, 80);
  const country = text(row.podNatnCd, 2).toUpperCase();
  const partner = COURIERS[text(row.trkrSvcCd, 2)];
  const courierNumber = Number(row.refBlNoCnt) === 1 ? text(row.refBlNo).replace(/[\s-]+/g, '').toUpperCase() : '';
  // The courier carries the parcel on under its number when its own rules offer that number.
  const handoff = partner && courierNumber && (detectCarrierMatch(courierNumber).candidates as string[]).includes(partner)
    ? { delivery_carrier: partner, delivery_tracking_number: courierNumber } : {};
  return {
    status: current ? languageStageStatus(current.stage) : 'unknown',
    ...(current ? { current_stage: current.stage, current_stage_source: current.source } : {}),
    last_status_text: newest.event.description!,
    last_update: null,
    last_update_local: newest.event.local_time,
    expected_delivery: null,
    ...(recipient ? { receiver_name: recipient } : {}),
    ...(/^[A-Z]{2}$/.test(country) ? { destination_country: country } : {}),
    ...handoff,
    events: scans.map(scan => scan.event),
  };
}

import { load } from 'cheerio';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { jtlExpressStage } from './status.js';

export const PROVIDER = 'jtl-express-id';
// A reply with four rows is under 2 kB.
export const MAX_BYTES = 256_000;
const MAX_ROWS = 300;
// A branch code, a month (MMYY) and a serial, as on the tracker's own placeholder. The library
// hands adapters numbers without hyphens, and the tracker knows a resi only with them.
const NUMBER = /^([A-Z0-9]{2,12})-?(\d{4})-?(\d{5})$/;
const DAY = /^(\d{2})-(\d{2})-(\d{4})$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
// The tracker's answer for a number it does not know.
const UNKNOWN = 'Resi tidak ditemukan';
// "… oleh [SIGESIT - name]": the courier, or the person who took the parcel, named after "oleh".
const NAMED = /\s*\boleh\b\s*(?:\[[^\]]*\]|[^-[]*)/gi;
// "(Estimasi 3 - 4 hari)" after the service's name.
const ESTIMATE = /\s*\(estimasi\b[^)]*\)\s*$/i;

/** A resi as the tracker takes it: in capitals, its branch, month and serial joined by hyphens. */
export function normalizeJtlExpressNumber(raw: string): string {
  const parts = NUMBER.exec(typeof raw === 'string' && raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '');
  if (!parts) throw new InvalidInputError(PROVIDER, 'Enter a JTL Express resi: a branch code, a month and a serial, as C4BLT002-0323-00006');
  return `${parts[1]}-${parts[2]}-${parts[3]}`;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

type Row = CarrierEvent & { local_time: string; description: string };

/** A row's sentence without the name of the courier or of whoever took the parcel. */
export function jtlExpressDescription(text: string): string {
  return clean(text.replace(NAMED, ' '), 300);
}

function rows(html: string): Row[] {
  const $ = load(html);
  const steps = $('div.step').toArray();
  if (steps.length > MAX_ROWS) return invalid('JTL Express returned too many rows');
  return steps.map((step) => {
    const row = $(step);
    const day = DAY.exec(clean(row.find('.title').first().text()));
    const clock = CLOCK.exec(clean(row.find('.kecil').first().text()));
    const date = day ? calendarDay(Number(day[3]), Number(day[2]), Number(day[1])) : null;
    const description = jtlExpressDescription(row.find('.caption').first().text());
    const year = Number(day?.[3]);
    if (!date || !clock || year < 2001 || year > 2100 || !description) return invalid('JTL Express returned an unreadable row');
    const stage = jtlExpressStage(description);
    return { local_time: `${date}T${clock[1]}:${clock[2]}:${clock[3] ?? '00'}`, description,
      ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}) };
  });
}

/** Reads the tracker's reply for a resi. */
export function parseJtlExpress(body: unknown, number: string): CarrierResult {
  if (!isRecord(body) || (body.hasil !== 0 && body.hasil !== 1 && body.hasil !== '0' && body.hasil !== '1')) {
    return invalid('JTL Express returned an invalid reply');
  }
  if (Number(body.hasil) !== 1) {
    if (clean(body.pesan) === UNKNOWN) throw new NotFoundError(PROVIDER, 'JTL Express does not know this resi');
    throw new IndeterminateError(PROVIDER, 'JTL Express did not confirm the resi');
  }
  const resi = clean(body.resi, 64).toUpperCase();
  if (!resi) return invalid('JTL Express returned a reply without its resi');
  if (resi !== number) throw new IndeterminateError(PROVIDER, 'JTL Express answered for another resi');
  if (typeof body.tabel !== 'string') return invalid('JTL Express returned a reply without its rows');

  // The tracker lists the rows newest first.
  const seen = new Set<string>();
  const events = rows(body.tabel).map((event, index) => ({ event, index })).filter(({ event }) => {
    const key = JSON.stringify([event.local_time, event.description]);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.event.local_time.localeCompare(a.event.local_time) || a.index - b.index).map(({ event }) => event);
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'JTL Express lists the resi without rows', { reason: 'listed' });

  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  const service = clean(body.layanan, 120);
  const serviceName = clean(service.replace(ESTIMATE, ''), 120);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: null,
    ...(serviceName ? { service_name: serviceName } : {}),
    ...(ESTIMATE.test(service) ? { unread_estimates: ['layanan'] } : {}),
    destination_country: 'ID',
    events,
  };
}

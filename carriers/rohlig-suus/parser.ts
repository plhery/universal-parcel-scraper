import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean, cleanScalar } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { SUUS_EVENTS } from './status.js';

export const PROVIDER = 'Rohlig SUUS Logistics';
export const MAX_BYTES = 256_000;
const MAX_EVENTS = 300;
/** The event whose note the page shows: the planned delivery day. */
const PLANNED = '327';
const CLOCK = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;
const DAY = /^(\d{4}-\d{2}-\d{2})T00:00:00$/;

/**
 * The depots the guest tracker names by code, as its locations dictionary
 * (`/api/parcel/tracking/dictionaries/locations`) gives their towns.
 */
const DEPOTS: Readonly<Record<string, string>> = {
  PIE: 'Sokołów', CPR: 'Gdynia', POZ: 'Tarnowo', KTW: 'Sosnowiec', GDY: 'Gdansk', LBL: 'Lublin', SCZ: 'Szczecin',
  BIA: 'Białystok', KRA: 'Kokotów', WRO: 'Nowa Wieś', BYD: 'Bydgoszcz', RZS: 'Rzeszow', KBA: 'Skawina', LDZ: 'Lodz',
  WAW: 'Warsaw', GDA: 'Gdynia', KAL: 'Kalisz', ZIE: 'Zielona Góra', WIS: 'Warsaw', ESM: 'Warsaw', KSZ: 'Koszalin',
  KON: 'Konin', OSZ: 'Olsztyn', WAG: 'Warsaw', GLX: 'Gliwice', GRZ: 'Gorzow', KLC: 'Kielce', PLO: 'Płońsk',
  GRU: 'Grudziadz', LBP: 'Biała Podlaska',
};

/** A number as the guest tracker takes it: letters and digits, upper case, without spaces. */
export function normalizeRohligSuusNumber(raw: string): string {
  const number = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

interface Scan { key: string; event: CarrierEvent & { local_time: string; description: string }; stage?: Stage }

function scanOf(value: unknown): Scan | null {
  if (!isRecord(value)) throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics returned an unreadable event');
  const code = cleanScalar(value.statusId, 8);
  const clock = CLOCK.exec(clean(value.created, 40))?.[1];
  if (!/^\d{1,6}$/.test(code) || !clock) throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics returned an unreadable event');
  // An id outside the visible dictionary is an event the page hides.
  const known = SUUS_EVENTS.get(code);
  if (!known) return null;
  const note = code === PLANNED ? clean(value.eventNote, 100) : '';
  const depot = cleanScalar(value.location, 8).toUpperCase();
  const location = DEPOTS[depot];
  return {
    key: JSON.stringify([code, clock, depot]),
    event: { local_time: clock, description: note ? `${known.wording} ${note}` : known.wording,
      ...(location ? { location } : {}), provider_code: code,
      ...(known.stage ? { stage: known.stage, stage_source: 'carrier_map' } : {}) },
    ...(known.stage ? { stage: known.stage } : {}),
  };
}

/**
 * The guest tracker's order for one number, as the browser service passes it on: its status,
 * planned delivery day and events, each on the depot's wall clock, which the reply does not
 * place in a zone.
 */
export function parseRohligSuus(payload: unknown, number: string): CarrierResult {
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics returned an unreadable reply');
  if (cleanScalar(payload.parcelNumber, 40).replace(/\s+/g, '').toUpperCase() !== number) {
    throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics answered for another number');
  }
  if (payload.events === undefined || payload.events === null) throw new NoHistoryError(PROVIDER);
  if (!Array.isArray(payload.events)) throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics returned an unreadable history');
  const list: unknown[] = payload.events;
  if (list.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'Rohlig SUUS Logistics returned an excessive history');
  const seen = new Set<string>();
  const scans: Scan[] = [];
  for (const value of list) {
    const scan = scanOf(value);
    if (!scan || seen.has(scan.key)) continue;
    seen.add(scan.key);
    scans.push(scan);
  }
  if (!scans.length) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed' });
  // Newest first by wall clock; a stable sort keeps the reply's order within one second.
  scans.sort((a, b) => b.event.local_time.localeCompare(a.event.local_time));
  const events = scans.map((scan) => scan.event);
  const newest = events[0]!;
  // Billing, notes and estimates follow the journey without moving the parcel.
  const current = scans.find((scan) => scan.stage);
  const stage = current?.stage;
  const settled = stage === 'delivered' || stage === 'returned';
  const planned = DAY.exec(clean(payload.deliveryDate, 40))?.[1];
  const countries = Array.isArray(payload.destinations)
    ? [...new Set(payload.destinations.map((x) => (isRecord(x) ? cleanScalar(x.country, 4).toUpperCase() : '')))] : [];
  const country = countries.length === 1 && /^[A-Z]{2}$/.test(countries[0]!) ? countries[0] : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: (current?.event ?? newest).description,
    last_update: null,
    last_update_local: newest.local_time,
    expected_delivery: !settled && planned ? planned : null,
    ...(country ? { destination_country: country } : {}),
    events,
  };
}

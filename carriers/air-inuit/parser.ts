import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { isoTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { airInuitStage } from './status.js';

export const PROVIDER = 'air-inuit';
export const AIR_INUIT_ORIGIN = 'https://www.airinuit.com/';

// Air Inuit's stations, in Nunavik and southern Quebec, keep Eastern time.
const ZONE = 'America/Toronto';
const MAX_ROWS = 500;

/** An Air Inuit air waybill: its eight-digit serial, and the station printed after the 466 prefix, if given. */
export interface AirInuitWaybill {
  serial: string;
  station?: string;
}

// 466, the station that issued it, then eight digits: "466-YKL-13472675". The form takes the
// serial alone.
const WAYBILL = /^(?:466[\s-]?(?:([A-Z]{3})[\s-]?)?)?(\d{8})$/;

export function airInuitWaybill(raw: string): AirInuitWaybill {
  const match = WAYBILL.exec(raw.trim().toUpperCase());
  if (!match) throw new InvalidInputError(PROVIDER, 'Enter an Air Inuit air waybill: 466, then eight digits');
  return { serial: match[2]!, ...(match[1] ? { station: match[1] } : {}) };
}

export function airInuitUrl(waybill: AirInuitWaybill): string {
  // lang 2 is English.
  return `${AIR_INUIT_ORIGIN}cargo.php?${new URLSearchParams({ id: waybill.serial, lang: '2' })}`;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

// "Accepted by Air Inuit Cargo in Schefferville (YKL)." or "Received in Montréal Dorval (YUL)."
const IN_STATION = /\bin (\S.*\([A-Z]{3}\))\.$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^(\d{2}:\d{2}:\d{2})(?:\.\d{1,7})?$/;

type Line = CarrierEvent & { local_time: string; description: string };

function line(value: unknown, destination: string): Line {
  const row = record(value);
  const sentence = record(row?.oSentence);
  // A manifest line breaks before the flight's date: "Manifested on flight 3H833 <br> for May 25, …".
  const description = clean(typeof sentence?.m_Sentence === 'string' ? sentence.m_Sentence.replace(/<[^>]*>/g, ' ') : '');
  const day = clean(row?.m_sDateHistory);
  const clock = CLOCK.exec(clean(row?.m_sHeureHistory));
  const local = DAY.test(day) && clock ? `${day}T${clock[1]}` : '';
  const instant = local ? isoTime(local, ZONE) : null;
  const year = Number(day.slice(0, 4));
  const code = typeof row?.statuID === 'number' && Number.isInteger(row.statuID) ? String(row.statuID) : '';
  if (!description || !instant || year < 2001 || year > 2100 || !code) {
    throw new SchemaError(PROVIDER, 'Air Inuit returned an invalid history line');
  }
  const location = clean(row?.m_sLegFROM) || IN_STATION.exec(description)?.[1] || '';
  let stage: Stage | undefined = airInuitStage(code);
  if (stage === 'ready_for_pickup' && location !== destination) stage = 'in_transit';
  return {
    time: instant.iso, local_time: local, time_zone: ZONE, time_zone_basis: 'carrier',
    description, ...(location ? { location } : {}), provider_code: code,
    ...(stage ? { stage, stage_source: 'carrier_map' as const } : {}),
  };
}

/** Reads cargo.php's reply for the waybill asked. */
export function parseAirInuit(body: unknown, waybill: AirInuitWaybill): CarrierResult {
  const reply = record(body);
  const data = record(reply?.data);
  if (!reply || typeof reply.status !== 'string' || !data) throw new SchemaError(PROVIDER, 'Air Inuit returned an invalid reply');
  // An unknown waybill gets an empty status and a blank record.
  if (reply.status === '' && data.ReceivingId === 0 && clean(data.FormNumber) === '') throw new NotFoundError(PROVIDER);
  if (reply.status.toLowerCase() !== 'ok') throw new IndeterminateError(PROVIDER, 'Air Inuit did not confirm the waybill');

  const prefix = /^466-([A-Z]{3})-$/.exec(clean(data.AwbPrefix));
  if (!prefix) throw new SchemaError(PROVIDER, 'Air Inuit returned an invalid waybill prefix');
  if (clean(data.FormNumber) !== waybill.serial || (waybill.station && prefix[1] !== waybill.station)) {
    throw new IndeterminateError(PROVIDER, 'Air Inuit answered for another waybill');
  }

  const goods = data.CommoditiesByNatureOfGoods;
  if (!Array.isArray(goods)) throw new SchemaError(PROVIDER, 'Air Inuit returned no goods');
  const destination = clean(data.UltimateDestination);
  const rows = goods.flatMap((item) => {
    const history = record(item)?.HistoriqueNew;
    if (!Array.isArray(history)) throw new SchemaError(PROVIDER, 'Air Inuit returned an invalid history');
    return history as unknown[];
  });
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Air Inuit returned too many history lines');

  // Each line of goods carries the waybill's history; the lines they share are kept once.
  const seen = new Set<string>();
  const events = rows.map((row) => line(row, destination)).filter((event) => {
    const key = JSON.stringify([event.local_time, event.description, event.location ?? '']);
    return !seen.has(key) && Boolean(seen.add(key));
  }).sort((a, b) => b.local_time.localeCompare(a.local_time));
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Air Inuit lists the waybill without history', { reason: 'listed' });

  const stage = events.find((event) => event.stage)?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description,
    last_update: newest.time!,
    last_update_local: newest.local_time,
    expected_delivery: null,
    events,
  };
}

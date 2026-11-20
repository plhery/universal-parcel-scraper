import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { stageForActivity, type Activity } from './status.js';

export const provider = 'air-greenland';

const clockPattern = '(\\d{2}(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?: [0-2]\\d:[0-5]\\d)?)';
const arrivalPattern = new RegExp(`^arrived at (.+?) on ([A-Z0-9]+) ${clockPattern}$`, 'i');
const manifestPattern = new RegExp(`^manifested on ([A-Z0-9]+) ${clockPattern} from (.+?) to .+$`, 'i');
const deliveryPattern = new RegExp(`^delivered ${clockPattern} at (.+?)(?: to (.+))?$`, 'i');
const airportPattern = /^[\p{L}][\p{L} .'-]{0,79}$/u;

interface Scan {
  activity: Activity;
  pieces: number;
  kilograms: number;
  location: string;
  clock: string;
  description: string;
}

function readScan(line: string): Scan | undefined {
  const parsed = /^(\d+) pieces? (\d+(?:[.,]\d+)?) kg (.+)$/i.exec(line);
  if (!parsed) return undefined;
  const [ , count, weight, wording] = parsed;
  const pieces = Number(count);
  const kilograms = Number(weight!.replace(',', '.'));
  if (!Number.isSafeInteger(pieces) || pieces < 1 || !Number.isFinite(kilograms)) return undefined;
  const arrival = arrivalPattern.exec(wording!);
  const manifest = manifestPattern.exec(wording!);
  const delivery = deliveryPattern.exec(wording!);
  const base = { pieces, kilograms };
  const quantity = `${pieces} ${pieces === 1 ? 'piece' : 'pieces'}`;
  if (arrival && airportPattern.test(arrival[1]!)) {
    return { ...base, activity: 'arrived', location: arrival[1]!, clock: arrival[3]!, description: `${quantity} arrived on ${arrival[2]}` };
  }
  if (manifest && airportPattern.test(manifest[3]!)) {
    return { ...base, activity: 'manifested', location: manifest[3]!, clock: manifest[2]!, description: `${quantity} manifested on ${manifest[1]}` };
  }
  if (delivery && airportPattern.test(delivery[2]!)) {
    const handler = /^handling agent$/i.test(delivery[3] ?? '');
    return {
      ...base, activity: handler ? 'delivered_to_handler' : 'delivered',
      location: delivery[2]!, clock: delivery[1]!,
      description: handler ? `${quantity} delivered to handling agent` : `${quantity} delivered`,
    };
  }
  return undefined;
}

export function parseTracking(body: unknown, reference: string): CarrierResult {
  if (!isRecord(body)) throw new SchemaError(provider, 'Invalid Air Greenland tracking reply');
  if (body.queryOkay === false && body.awbNo === null && body.statusList === null) {
    throw new NotFoundError(provider);
  }
  if (body.queryOkay !== true || typeof body.awbNo !== 'string'
    || !Array.isArray(body.statusList) || !body.statusList.every(line => typeof line === 'string')) {
    throw new SchemaError(provider, 'Invalid Air Greenland shipment record');
  }
  if (body.awbNo.replace(/^631-/, '631') !== reference) {
    throw new IndeterminateError(provider, 'Air Greenland replied to another air waybill');
  }

  const lines = [...new Set(body.statusList.map(line => clean(line)))].filter(Boolean);
  const scans = lines.map(readScan).filter(scan => scan !== undefined);
  if (!scans.length) throw new NoHistoryError(provider);
  const pieces = Number(clean(body.packageQuantity));
  const weight = /^(\d+(?:[.,]\d+)?) kg$/i.exec(clean(body.weight));
  const destination = clean(body.to).toUpperCase();
  const delivered = scans.filter(scan => scan.activity === 'delivered' && scan.location.toUpperCase() === destination);
  // The response repeats some scans and can list different delivery quantities on one waybill.
  // Count an indistinguishable group once and require all reported pieces to reach the destination.
  const distinct = new Map(delivered.map(scan => [`${scan.pieces}/${scan.kilograms}`, scan.pieces]));
  const complete = pieces > 0 && (delivered.some(scan => scan.pieces === pieces)
    || [...distinct.values()].reduce((total, count) => total + count, 0) === pieces);
  const stage = complete ? 'delivered' : 'in_transit';
  const events: CarrierEvent[] = scans.map(scan => ({
    description: scan.description,
    location: scan.location,
    provider_time_text: scan.clock,
    stage: scan.activity === 'delivered' && (!complete || scan.location.toUpperCase() !== destination)
      ? 'in_transit' : stageForActivity[scan.activity],
    stage_source: 'carrier_map',
  }));
  return {
    status: languageStageStatus(stage),
    current_stage: stage,
    current_stage_source: 'carrier_map',
    last_update: null,
    ...(weight ? { weight_kg: Number(weight[1]!.replace(',', '.')) } : {}),
    ...(scans.length < lines.length ? { history_truncated: true } : {}),
    events,
  };
}

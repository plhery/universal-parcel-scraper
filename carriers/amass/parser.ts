import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { epochMillisTime } from '../../core/time/index.js';
import { isRecord } from '../../core/types.js';
import { amassStage } from './status.js';

export const PROVIDER = 'AMASS';
// An order's steps are a few kilobytes.
export const AMASS_MAX_BYTES = 512 * 1024;

/** What the tracker is asked for, and the order it must answer with. */
export interface AmassQuery {
  /** The bill or order number as the tracker takes it. */
  readonly number: string;
  /** The order's nine digits, which the reply names. */
  readonly order: string;
}

// A house bill: AMI, two letters, the order's nine digits and a letter. The order alone is nine digits.
const BILL = /^AMI[A-Z]{2}(\d{9})[A-Z]$/;
const ORDER = /^\d{9}$/;
const MAX_EVENTS = 200;

/** A house bill of lading or its order number, as the tracker takes it. */
export function amassQuery(raw: string): AmassQuery {
  const number = typeof raw === 'string' && raw.length <= 64 ? raw.toUpperCase().replace(/[\s.-]/g, '') : '';
  const bill = BILL.exec(number);
  if (bill) return { number, order: bill[1]! };
  if (ORDER.test(number)) return { number, order: number };
  throw new InvalidInputError(PROVIDER, 'AMASS tracks a house bill of lading or its order number');
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };
const text = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The order's steps from the tracker's reply, the newest first. */
export function parseAmass(body: string, query: AmassQuery): CarrierResult {
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    return invalid('AMASS returned an unreadable reply');
  }
  if (!isRecord(reply)) return invalid('AMASS returned an invalid reply');
  const code = text(reply.messagecode, 10);
  // The page sends a guest to log in, or asks for a booking account, for an order it shows only to its customer.
  if (code === '403' || code === '10020' || code === '411') {
    throw new IndeterminateError(PROVIDER, 'AMASS shows this order only to its booking account', { reason: 'tracking_withheld' });
  }
  if (code === '302') throw new NotFoundError(PROVIDER, 'AMASS has no order for this number');
  // The page reads any other code as an order it cannot find, which could also be a fault.
  if (code !== '0') throw new IndeterminateError(PROVIDER, 'AMASS returned an unexplained answer');
  const data = reply.data;
  if (!isRecord(data) || !isRecord(data.traceInfo) || !Array.isArray(data.traceLocation)) return invalid('AMASS returned an order without its steps');
  if (text(data.traceInfo.orderCode, 20) !== query.order) throw new IndeterminateError(PROVIDER, 'AMASS answered for another order');

  const seen = new Set<string>();
  const events = data.traceLocation.flatMap((step, order): { event: CarrierEvent; timestamp: number; order: number }[] => {
    if (!isRecord(step)) return invalid('AMASS returned an invalid step');
    const time = epochMillisTime(step.time);
    const description = text(step.descriptionEn, 200) || text(step.description, 200);
    if (!time || !description) return invalid('AMASS returned a step without its time or wording');
    // The tracker repeats a step its lists share.
    const key = JSON.stringify([time.iso, description]);
    if (seen.has(key)) return [];
    seen.add(key);
    const stage = amassStage(description);
    return [{ timestamp: time.timestamp, order, event: { time: time.iso, description, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) } }];
  })
    // The newest first; steps at one instant keep the order given, which lists the later first.
    .sort((left, right) => right.timestamp - left.timestamp || left.order - right.order)
    .map(({ event }) => event);
  if (!events.length) throw new NoHistoryError(PROVIDER, 'AMASS lists the order without steps', { reason: 'listed' });
  const newest = events[0]!;
  const current = events.find(event => event.stage);
  const stage = current?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(current ? { current_stage: stage, current_stage_source: current.stage_source } : {}),
    last_status_text: newest.description, last_update: newest.time, expected_delivery: null,
    ...(events.length > MAX_EVENTS ? { history_truncated: true } : {}), events: events.slice(0, MAX_EVENTS),
  };
}

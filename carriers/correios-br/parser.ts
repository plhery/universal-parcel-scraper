import { DateTime, IANAZone } from 'luxon';
import { isValidS10TrackingNumber } from '../../core/detection/s10.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { paddedDate } from '../../core/time/fields.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord, type JsonObject } from '../../core/types.js';
import { hasSeveralClocks, mainZone } from '../../places/zones.js';
import { classifyCorreiosScan } from './status.js';

export function normalizeCorreiosNumber(raw: string): string {
  const number = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (!/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(number) || !isValidS10TrackingNumber(number)) {
    throw new InvalidInputError('Correios', 'Correios requires a valid postal S10 tracking number');
  }
  return number;
}

export function isCorreiosCaptchaError(payload: unknown): boolean {
  return isRecord(payload) && (payload.erro === true || payload.erro === 'true')
    && clean(payload.mensagem, 100).toLowerCase() === 'captcha inválido';
}

type ScanClock = Pick<CarrierEvent, 'time' | 'time_zone' | 'time_zone_basis'> & { local_time?: string; provider_time_text?: string };

/**
 * A row's clock. `abroad` is the zone of the sending post's country for a row there, null when
 * that country keeps several clocks: Correios writes such a row on that post's wall clock and
 * labels it with Brasília's zone, so its own zone is not read.
 */
function scanClock(value: unknown, abroad?: string | null, basis = 'place'): ScanClock {
  const raw = clean(isRecord(value) ? value.date : value, 64);
  const digits = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.\d{1,6})?$/.exec(raw)?.[1];
  const wall = digits ? DateTime.fromFormat(digits, 'yyyy-MM-dd HH:mm:ss', { zone: 'UTC' }) : null;
  if (!wall?.isValid) return raw ? { provider_time_text: raw } : {};
  const local = wall.toISO({ includeOffset: false, suppressMilliseconds: true });
  const stated = isRecord(value) && value.timezone_type === 3 ? clean(value.timezone, 64) : '';
  // Correios labels relayed origin clocks with Brasília's zone. Preserve any other stated zone.
  if (stated !== 'America/Sao_Paulo') abroad = undefined;
  const zone = abroad === undefined ? stated : abroad ?? '';
  if (!zone || !IANAZone.isValidZone(zone)) return { local_time: local };
  // Use the explicit per-row zone only when its clock exists uniquely. Do not
  // silently shift a nonexistent DST clock or choose between repeated clocks.
  const zoned = firstOccurrence(DateTime.fromFormat(digits!, 'yyyy-MM-dd HH:mm:ss', { zone }));
  if (!zoned.isValid || zoned.toFormat('yyyy-MM-dd HH:mm:ss') !== digits || zoned.getPossibleOffsets().length !== 1) {
    return { local_time: local };
  }
  const time = zoned.toISO({ suppressMilliseconds: true });
  return abroad === undefined ? { time } : { time, local_time: local, time_zone: zone, time_zone_basis: basis };
}

// The sending post's rows for mail from abroad: its posting and its office of exchange.
const ABROAD = /^(?:PO\/\d{2}|PAR\/18)$/;
// Its dispatch to Brazil, a transfer listed without a Brazilian unit before the item's first scan in Brazil. China
// Post's history shows its dispatch at that wall clock; on Brasília's clock it would lie hours ahead when first listed.
const TRANSFERS = new Set(['RO/01', 'DO/01']);
// Customs' review of the declaration: the recipient's tax number asked for or under review, the information sent to
// customs, the product's classification and the import authorized, with or without its taxes due. Correios does it in Brazil,
// at the unit it names, while the item may still be with the sending post, so these rows do not show the item reached Brazil.
const DECLARATION_REVIEW = new Set(['FC/16', 'PAR/12', 'PAR/21', 'FC/40', 'PAR/07', 'PAR/17']);

/** The Brazilian unit a row names, as "city, state", or empty. */
function unitPlace(row: JsonObject): string {
  const address = isRecord(row.unidade) && isRecord(row.unidade.endereco) ? row.unidade.endereco : null;
  return address ? [clean(address.cidade, 100), clean(address.uf, 8)].filter(Boolean).join(', ') : '';
}

// The portal shows its delivery forecast only for an object in transit
// (situacao T) that it does not mark as late.
function expectedDay(payload: JsonObject, stage: string | undefined): string | null {
  if (payload.situacao !== 'T' || payload.atrasado === true) return null;
  if (stage && ['delivered', 'returned', 'ready_for_pickup'].includes(stage)) return null;
  const day = DateTime.fromFormat(paddedDate(clean(payload.dtPrevista, 16)), 'dd/MM/yyyy', { zone: 'UTC' });
  return day.isValid ? day.toISODate() : null;
}

const POSTINGS = new Set(['PO/01', 'PO/09']);
// Stages that come before the item moves: a label issued, the item posted.
const UNMOVED = new Set<string | undefined>([undefined, 'pending', 'registered', 'accepted']);

/**
 * A posting listed once the item has moved on is the item moving on, not its
 * acceptance. Mail from abroad can list the sending post's posting twice, the
 * second time when that post dispatched the item. An import Correios numbers
 * itself (`NN…BR`) lists the declaration sent to customs first, often after
 * the shipper's export clearance, and its posting when the shipper hands it
 * to the airline abroad. Events are newest first.
 */
function laterPostingsInTransit(events: CarrierEvent[]): void {
  let moved = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    const posting = POSTINGS.has(event.provider_code ?? '');
    if (posting && moved) events[index] = { ...event, stage: 'in_transit' };
    moved ||= posting || !UNMOVED.has(event.stage);
  }
}

export function parseCorreios(payload: unknown, number: string): CarrierResult {
  const requested = normalizeCorreiosNumber(number);
  if (!isRecord(payload)) throw new SchemaError('Correios');
  if (isCorreiosCaptchaError(payload)) throw new ChallengeError('Correios', 'Correios rejected the text CAPTCHA');
  // Period errors and other unbound error replies prove neither absence nor identity.
  if (payload.erro === true || payload.erro === 'true') throw new IndeterminateError('Correios', 'Correios returned an inconclusive tracking response');
  if (payload.codObjeto !== requested) throw new SchemaError('Correios', 'Correios returned a different tracking object');
  if (!Array.isArray(payload.eventos) || payload.eventos.length > 500) throw new SchemaError('Correios');
  // Mail from abroad keeps the S10 number of the post that sent it, whose country ends it.
  const origin = requested.slice(-2);
  // A country of several clocks gives its main one, the sending post's own: a wall clock left alone would be dated on
  // Brasília's after the parser.
  const originZone = origin === 'BR' ? undefined : mainZone(origin);
  const originBasis = hasSeveralClocks(origin) ? 'carrier' : 'place';
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  // Rows are newest first: those after the oldest row naming a Brazilian unit come before the item reached Brazil. A
  // review of the declaration is no such row.
  let inBrazil = -1;
  payload.eventos.forEach((row, index) => {
    if (isRecord(row) && unitPlace(row) && !DECLARATION_REVIEW.has(`${clean(row.codigo, 8)}/${clean(row.tipo, 8)}`)) inBrazil = index;
  });
  for (const [index, row] of payload.eventos.entries()) {
    if (!isRecord(row)) throw new SchemaError('Correios', 'Correios returned an incomplete scan');
    const code = clean(row.codigo, 8);
    const subtype = clean(row.tipo, 8);
    const description = clean(row.descricao, 500);
    if (!/^[A-Z]{2,4}$/.test(code) || !/^\d{2}$/.test(subtype) || !description) throw new SchemaError('Correios', 'Correios returned an incomplete scan');
    const providerCode = `${code}/${subtype}`;
    const location = unitPlace(row);
    const sent = !location && index > inBrazil && (ABROAD.test(providerCode) || TRANSFERS.has(providerCode));
    const clock = scanClock(row.dtHrCriado, sent ? originZone : undefined, originBasis);
    const key = `${clock.time ?? clock.local_time ?? clock.provider_time_text ?? ''}\u0000${providerCode}\u0000${description}\u0000${location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mapped = classifyCorreiosScan(providerCode, description);
    events.push({ description, provider_code: providerCode, ...clock, ...(location ? { location } : {}), ...(mapped ? { stage: mapped.stage } : {}) });
  }
  if (!events.length) throw new IndeterminateError('Correios', 'Correios returned no tracking scans');
  laterPostingsInTransit(events);
  // The single-object response is newest first. Keep unresolved clocks there.
  const latest = events[0]!;
  const mapped = classifyCorreiosScan(latest.provider_code ?? '', latest.description ?? '');
  const service = isRecord(payload.tipoPostal) ? clean(payload.tipoPostal.categoria, 80) : '';
  return { status: mapped?.status ?? 'unknown', ...(latest.stage ? { current_stage: latest.stage } : {}),
    last_status_text: latest.description, last_update: latest.time ?? null, last_update_local: latest.local_time ?? null,
    expected_delivery: expectedDay(payload, latest.stage), ...(mapped?.status === 'delivered' && latest.time ? { delivered_at: latest.time } : {}),
    ...(service ? { service_name: service } : {}), events: events.slice(0, 100) };
}

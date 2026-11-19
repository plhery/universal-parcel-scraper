import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { scanStage, statusMap } from './status.js';

export const PROVIDER = 'South Post';
export const SOUTH_POST_URL = 'https://tracker.southpost.com.ar/seguimiento';
export const SOUTH_POST_MAX_BYTES = 512 * 1024;
const ZONE = 'America/Argentina/Buenos_Aires';

/** A shipment number: digits, at most the seven the page's form takes. */
export function normalizeSouthPostNumber(raw: string): string {
  const number = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,7}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;
const DAY = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^\d{2}:\d{2}$/;
const STAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}):\d{2}$/;

/**
 * A scan's clock, on Argentina's UTC−03:00. The row's `receptor_fecha_hora` gives the same
 * minute as its `fecha` and `hora` with the seconds, and is read when it agrees with them.
 */
function scanTime(row: Record<string, unknown>): ParsedTime | null {
  const day = DAY.exec(clean(row.fecha, 16));
  const clock = clean(row.hora, 8);
  if (!day || !CLOCK.test(clock)) return null;
  const stamp = clean(row.receptor_fecha_hora, 32);
  const precise = STAMP.exec(stamp);
  if (precise && precise[1] === day[3] && precise[2] === day[2] && precise[3] === day[1] && precise[4] === clock) {
    return zonedTime(stamp, 'yyyy-MM-dd HH:mm:ss', ZONE);
  }
  return zonedTime(`${day[0]} ${clock}`, 'dd/MM/yyyy HH:mm', ZONE);
}

/** Read one reply of the tracker: the shipment asked about, or a failure of its own kind. */
export function parseSouthPostReply(body: string, rawNumber: string): CarrierResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'South Post answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'South Post answered with a page instead of its tracking JSON', { cause });
  }
  return parseSouthPost(payload, rawNumber);
}

interface Scan { event: CarrierEvent; at: number; index: number; signatory: string }

export function parseSouthPost(payload: unknown, rawNumber: string): CarrierResult {
  const number = normalizeSouthPostNumber(rawNumber);
  // The tracker answers an unknown number as it answers its own failures; it tells neither apart.
  if (isRecord(payload) && typeof payload.error === 'string' && payload.data === undefined) {
    throw new IndeterminateError(PROVIDER, 'South Post\'s tracker answered with an error');
  }
  if (!isRecord(payload) || payload.nro_guia !== number) throw new SchemaError(PROVIDER, 'South Post did not identify the requested shipment');
  const data = payload.data;
  const guide = isRecord(data) && data.status === 'ok' ? data.guia : undefined;
  const rows = isRecord(guide) ? guide.fechas : undefined;
  if (!Array.isArray(rows) || !rows.length) throw new SchemaError(PROVIDER, 'South Post returned a shipment without its history');
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'South Post returned too long a history');

  const scans: Scan[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'South Post returned an unreadable scan');
    if (String(row.guia) !== number) throw new SchemaError(PROVIDER, 'South Post returned a scan of another shipment');
    const wording = clean(row.estado, 120);
    const at = scanTime(row);
    if (!wording || !at) throw new SchemaError(PROVIDER, 'South Post returned a scan without a status or a readable clock');
    const code = typeof row.codigo_estado === 'number' && Number.isInteger(row.codigo_estado) && row.codigo_estado >= 0 ? String(row.codigo_estado) : '';
    const stage = scanStage(wording);
    scans.push({ at: at.timestamp, index, signatory: clean(row.receptor, 120) || clean(row.receptor_nombre, 120), event: {
      time: at.iso, description: wording,
      ...(code ? { provider_code: code } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}),
    } });
  }
  // The tracker lists the newest scan first; equal clocks keep its order.
  scans.sort((left, right) => right.at - left.at || left.index - right.index);
  const events = scans.map(({ event }) => event);
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  // A delivered shipment gets further "ENTREGADA" rows as its proof goes back to the sender;
  // the first of the newest run of deliveries is the delivery itself.
  const first = stage === 'delivered' ? scans.findIndex(scan => scan.event.stage === 'delivered') : -1;
  let end = first;
  while (end >= 0 && end + 1 < scans.length && scans[end + 1]!.event.stage === 'delivered') end += 1;
  const deliveries = first >= 0 ? scans.slice(first, end + 1) : [];
  const delivery = deliveries.at(-1);
  const signatory = delivery ? (delivery.signatory || deliveries.find(scan => scan.signatory)?.signatory) : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time ?? null,
    expected_delivery: null,
    ...(delivery ? { delivered_at: delivery.event.time } : {}),
    ...(signatory ? { signed_by: signatory } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}

import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError, TransportError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { leadingScan } from '../../core/result/unstaged.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime, type ParsedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { isRecord } from '../../core/types.js';
import { scanStage, statusMap } from './status.js';

export const PROVIDER = 'Paquetería Flecha Amarilla';
export const FLECHA_AMARILLA_MAX_BYTES = 1024 * 1024;
export const FLECHA_AMARILLA_URL = 'https://c1trtsss68.execute-api.us-east-1.amazonaws.com/prod/guias/rastreoGuias';

export interface FlechaGuia { prefix: string; number: string }

// The prefixes the tracker's form offers, longest first so CB and PB are not read as C and P.
const GUIA = /^(CB|PB|TP|C|P|I)[\s-]*(\d{4,12})$/;

/** A guía: one of the tracker's prefixes and its digits, written together, with a space or with a hyphen. */
export function normalizeFlechaNumber(raw: string): FlechaGuia {
  const match = GUIA.exec(typeof raw === 'string' ? raw.trim().toUpperCase() : '');
  if (!match) throw new InvalidInputError(PROVIDER);
  return { prefix: match[1]!, number: match[2]! };
}

const CHALLENGE_PAGE = /<title>\s*(?:Just a moment|Attention Required)|_cf_chl_opt|captcha|access denied/i;
// A .NET JSON date: epoch milliseconds and the offset of the branch's clock.
const DOTNET_DATE = /^\/Date\((-?\d{1,15})([+-])(\d{2})(\d{2})\)\/$/;
const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/**
 * A scan's clock: the wall clock `fechaTexto` with the offset `fecha` states, kept only when
 * both name the same instant.
 */
function scanTime(row: Record<string, unknown>): ParsedTime | null {
  const date = DOTNET_DATE.exec(clean(row.fecha, 40));
  const wall = WALL_CLOCK.exec(clean(row.fechaTexto, 32));
  if (!date || !wall) return null;
  const parsed = explicitOffsetTime(`${wall[1]}T${wall[2]}${date[2]}${date[3]}:${date[4]}`);
  return parsed && parsed.timestamp === Number(date[1]) ? parsed : null;
}

/** Read one reply of the tracker: the guía asked about, a missing one, or a failure of its own kind. */
export function parseFlechaReply(body: string, raw: string): CarrierResult {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE_PAGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Paquetería Flecha Amarilla answered with a verification page', { cause });
    throw new SchemaError(PROVIDER, 'Paquetería Flecha Amarilla answered with a page instead of its tracking JSON', { cause });
  }
  return parseFlecha(payload, raw);
}

interface Scan { event: CarrierEvent; at: number; index: number }

export function parseFlecha(payload: unknown, raw: string): CarrierResult {
  const asked = normalizeFlechaNumber(raw);
  if (!isRecord(payload)) throw new SchemaError(PROVIDER, 'Paquetería Flecha Amarilla returned no tracking reply');
  if (payload.codigoEstado !== 200) throw new TransportError(PROVIDER, 'Paquetería Flecha Amarilla could not read the guía');
  if (!Array.isArray(payload.respuesta)) throw new SchemaError(PROVIDER, 'Paquetería Flecha Amarilla returned no list of guías');
  // The tracker leaves out a guía it does not know, and the page then reports it has no information.
  // It also leaves out guías it knows when it is asked too often, with the same reply, so an empty
  // list does not say the guía is missing.
  if (!payload.respuesta.length) throw new IndeterminateError(PROVIDER, 'Paquetería Flecha Amarilla has no information for the guía', { reason: 'portal_not_found' });
  // The prefix comes padded with spaces.
  const guias = payload.respuesta.filter(guia => isRecord(guia) && clean(guia.prefijo, 8) === asked.prefix && clean(guia.numeroGuia, 20) === asked.number);
  if (guias.length !== 1 || payload.respuesta.length !== 1) throw new SchemaError(PROVIDER, 'Paquetería Flecha Amarilla did not identify the requested guía');
  const guia = guias[0] as Record<string, unknown>;
  const rows = guia.eventos;
  if (!Array.isArray(rows) || !rows.length) throw new SchemaError(PROVIDER, 'Paquetería Flecha Amarilla returned a guía without its history');
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Paquetería Flecha Amarilla returned too long a history');

  const scans: Scan[] = [];
  let receiver = '';
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) throw new SchemaError(PROVIDER, 'Paquetería Flecha Amarilla returned an unreadable event');
    const wording = clean(row.estadoActual, 120);
    const at = scanTime(row);
    if (!wording || !at) throw new SchemaError(PROVIDER, 'Paquetería Flecha Amarilla returned an event without a state or a readable clock');
    const stage = scanStage(wording);
    const location = clean(row.ciudadActual, 120);
    if (stage?.stage === 'delivered') receiver = clean(row.receptor, 120) || receiver;
    scans.push({ at: at.timestamp, index, event: {
      time: at.iso, description: wording,
      ...(location ? { location } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}),
    } });
  }
  // The tracker lists the oldest scan first, and a branch may log two states on the same second.
  scans.sort((left, right) => right.at - left.at || right.index - left.index);
  const events = scans.map(({ event }) => event);
  // A delivery stands only while no newer state may have undone it (`leadingScan`).
  const lead = leadingScan(events, statusMap);
  const stage = lead?.stage as Stage | undefined;
  const delivered = stage === 'delivered' ? events.find(event => event.stage === 'delivered') : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: lead!.stage_source } : {}),
    last_status_text: events[0]!.description!,
    last_update: events[0]!.time ?? null,
    expected_delivery: null,
    ...(delivered ? { delivered_at: delivered.time } : {}),
    ...(delivered && receiver ? { signed_by: receiver } : {}),
    events: events.slice(0, 100),
    ...(events.length > 100 ? { history_truncated: true } : {}),
  };
}

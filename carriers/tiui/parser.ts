import { tiuiFolio as folioOf } from '../../core/detection/tiui.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { tiuiStage } from './status.js';

export const PROVIDER = 'Tiui';
// A delivered folio's reply is a few kilobytes; its photos are links.
export const TIUI_MAX_BYTES = 512 * 1024;
const MAX_MOVEMENTS = 200;
// Milliseconds since 1970, which the reply writes as a string.
const EPOCH = /^\d{12,14}$/;
const NOT_FOUND = 'Guía no encontrada';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The folio as Tiui's tracker takes it: three groups of digits with their hyphens. */
export function tiuiFolio(raw: string): string {
  const folio = raw.length <= 64 ? folioOf(raw) : undefined;
  if (!folio) throw new InvalidInputError(PROVIDER, 'Tiui tracks a folio with its hyphens, as three groups of digits');
  return folio;
}

function instant(value: unknown): string | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !EPOCH.test(text)) return undefined;
  const date = new Date(Number(text));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Tiui's answer that it has no guide for the folio, which its 404 carries. */
export function isTiuiNotFound(body: unknown): boolean {
  return isObject(body) && body.isError === true && body.error === NOT_FOUND;
}

/**
 * The reply of Tiui's guide service, /api/guia/<folio>, which its tracking
 * page renders: the guide and its movements, newest first, each with a status
 * code, Tiui's wording and the instant it was written. The guide must be the
 * folio asked. The reply also holds the sender, the recipient, the merchant,
 * the courier who took each delivery photo and where, the photos and any
 * comments, none of which is read.
 */
export function parseTiui(body: unknown, raw: string): CarrierResult {
  const folio = tiuiFolio(raw);
  if (!isObject(body)) throw new SchemaError(PROVIDER, 'Tiui returned an unrecognized reply');
  if (typeof body.Folio !== 'string') throw new SchemaError(PROVIDER, 'Tiui returned a guide without its folio');
  if (body.Folio !== folio) throw new IndeterminateError(PROVIDER, 'Tiui answered for another folio');
  const movements = body.Movimientos;
  if (!Array.isArray(movements)) throw new SchemaError(PROVIDER, 'Tiui returned a guide without its movements');
  if (movements.length > MAX_MOVEMENTS) throw new SchemaError(PROVIDER, 'Tiui returned an oversized history');

  const events: CarrierEvent[] = movements.map((movement) => {
    if (!isObject(movement)) throw new SchemaError(PROVIDER, 'Tiui returned an unrecognized movement');
    const time = instant(movement.FechaRegistro);
    const code = typeof movement.EstatusNuevo === 'number' && Number.isInteger(movement.EstatusNuevo) ? String(movement.EstatusNuevo) : '';
    const description = clean(movement.estatusnuevoname, 300);
    if (!time || !code || !description) throw new SchemaError(PROVIDER, 'Tiui returned a movement without its time, code or wording');
    const staged = tiuiStage(code, description);
    return {
      time,
      description,
      provider_code: code,
      ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
    };
  });
  // Newest first, as the page lists them; movements of one instant keep the reply's order.
  const ordered = events.map((event, index) => ({ event, index }))
    .sort((left, right) => right.event.time!.localeCompare(left.event.time!) || left.index - right.index)
    .map(({ event }) => event);
  // A guide Tiui lists without a movement yet is Tiui's, before its first scan.
  if (!ordered.length) throw new NoHistoryError(PROVIDER, 'Tiui lists the folio without movements yet', { reason: 'listed' });
  const newest = ordered[0]!;
  const stage = newest.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: newest.stage_source } : {}),
    last_status_text: newest.description,
    last_update: newest.time,
    expected_delivery: null,
    events: ordered,
  };
}

import { IndeterminateError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { statuses } from './status.js';

export const provider = 'aeromexico-cargo';

type Movement = CarrierEvent & { provider_code: string; description: string; stage?: Stage };
const identityLine = /^(\d{3})-(\d{8})[A-Z]{6}\/([TP])(\d+)(?:[A-Z].*)?$/;
const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const partialDate = /^(0[1-9]|[12]\d|3[01])([A-Z]{3})(?:([01]\d|2[0-3])([0-5]\d))?$/;
const airport = /^[A-Z]{3}$/;
const route = /^[A-Z]{6}$/;

function movement(line: string, totalPieces: number | undefined): Movement | undefined {
  const [code = '', ...values] = line.split('/');
  if (!/^[A-Z]{3}$/.test(code) || !values.length) return;

  const status = statuses.get(code);
  const dateIndex = values.findIndex(value => partialDate.test(value));
  const date = partialDate.exec(values[dateIndex] ?? '');
  const day = date && monthNames.includes(date[2]!) ? date[1] + ' ' + date[2] : '';
  const clock = date?.[3] && date[4] ? date[3] + ':' + date[4] : '';
  const detail = day ? [day, clock].filter(Boolean).join(' ') : '';
  const place = dateIndex < 0 ? '' : values[dateIndex + 1] ?? '';
  const location = airport.test(place) ? place : route.test(place) ? place.slice(0, 3) : '';

  const pieces = values.find(value => /^[TP]\d+(?:[A-Z]\d+(?:\.\d+)?)?$/.test(value));
  const count = pieces && /^P(\d+)/.exec(pieces)?.[1];
  const fullDelivery = code === 'DLV'
    && (pieces?.startsWith('T') || (count && totalPieces !== undefined && Number(count) === totalPieces));
  const stage = code === 'DLV' && !fullDelivery ? 'in_transit' : status?.stage;
  const wording = code === 'DLV' && !fullDelivery ? 'Entrega registrada para parte de la carga' : status?.wording ?? code;
  const detailLabel = code === 'BKD' && detail ? 'vuelo programado ' + detail : detail;
  return {
    provider_code: code,
    description: wording + (detailLabel ? ' (' + detailLabel + ')' : ''),
    ...(location && { location }),
    ...(stage && { stage, stage_source: 'carrier_map' }),
  };
}

export function parseTracking(message: string, number: string): CarrierResult {
  const [envelope, ...rows] = message.trim().split(/\r?\n/);
  if (!/^FSA\/\d+$/.test(envelope ?? '')) {
    throw new SchemaError(provider, 'Aeroméxico Cargo did not return an air cargo status message');
  }

  const events: Movement[] = [];
  let matches = false;
  let totalPieces: number | undefined;
  for (const row of rows) {
    const line = row.trim();
    if (/^\d{3}-\d{8}/.test(line)) {
      const [, prefix, serial, pieceType, pieceCount] = identityLine.exec(line) ?? [];
      matches = prefix !== undefined && serial !== undefined && prefix + serial === number;
      totalPieces = matches && pieceType === 'T' ? Number(pieceCount) : undefined;
      continue;
    }
    if (!matches) continue;
    const event = movement(line, totalPieces);
    if (event) events.push(event);
    matches = false;
  }

  events.reverse();
  const current = events.find(event => event.stage === 'delivered')
    ?? events.find(event => event.stage && event.stage !== 'registered') ?? events[0];
  if (!current) {
    throw new IndeterminateError(provider, 'Aeroméxico Cargo did not return movements for the requested waybill');
  }

  const stage = current.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: current.description,
    provider_code: current.provider_code,
    events,
  };
}

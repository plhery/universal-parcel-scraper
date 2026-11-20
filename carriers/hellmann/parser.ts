import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { hellmannStage } from './status.js';

export const PROVIDER = 'Hellmann Worldwide Logistics';
export const HELLMANN_ORIGIN = 'https://public-road.tracking.hellmann.net';
export const HELLMANN_MAX_BYTES = 200_000;

export function normalizeHellmannPackage(raw: string): string {
  const number = raw.length <= 80 ? normalizeTrackingNumber(raw) : '';
  if (!/^00\d{18}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Hellmann road tracking takes a package NVE');
  return number;
}

export function hellmannPackageUrl(raw: string): string {
  const url = new URL('/public/api/v1/road/search', HELLMANN_ORIGIN);
  url.searchParams.set('hps.collino', normalizeHellmannPackage(raw));
  return url.href;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** The anonymous road response is a current shipment summary, not a scan list. */
export function parseHellmannPackage(text: string, raw: string): CarrierResult {
  const number = normalizeHellmannPackage(raw);
  if (/_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Access Denied|Attention Required)|_Incapsula_Resource/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'Hellmann answered with a browser check');
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new SchemaError(PROVIDER, 'Hellmann returned an unreadable road summary'); }
  if (!record(data) || typeof data.internalShipmentId !== 'string' || !/^\d{1,30}$/.test(data.internalShipmentId)
      || !Array.isArray(data.collis) || !data.collis.length || data.collis.length > 100) {
    throw new SchemaError(PROVIDER, 'Hellmann changed its road summary');
  }
  const matches = data.collis.filter(colli => record(colli) && colli.nve === number);
  if (matches.length !== 1) throw new IndeterminateError(PROVIDER, 'Hellmann did not uniquely confirm the whole package NVE');
  if (data.collis.length !== 1) throw new IndeterminateError(PROVIDER, 'Hellmann returned a multi-package shipment summary');
  if (typeof data.roadStatusFilter !== 'string' || !/^[A-Z_]{1,50}$/.test(data.roadStatusFilter)
      || !record(data.roadTransportPlanIcons) || typeof data.roadTransportPlanIcons.shipmentDeliveredIcon !== 'boolean') {
    throw new SchemaError(PROVIDER, 'Hellmann changed its current road status');
  }
  if ((data.roadStatusFilter === 'DELIVERED') !== data.roadTransportPlanIcons.shipmentDeliveredIcon) {
    throw new IndeterminateError(PROVIDER, 'Hellmann returned conflicting current status indicators');
  }
  const matched: unknown = matches[0];
  if (!record(matched) || (matched.status !== undefined && matched.status !== null && typeof matched.status !== 'string')) {
    throw new SchemaError(PROVIDER, 'Hellmann returned no package status');
  }
  if (typeof matched.status === 'string' && (data.roadStatusFilter === 'DELIVERED') !== (matched.status === 'DELIVERED')) {
    throw new IndeterminateError(PROVIDER, 'Hellmann did not confirm delivery of the requested package');
  }
  const clock = data.latestActualDateTime;
  if (typeof clock !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(clock)
      || !DateTime.fromISO(clock, { zone: 'UTC', setZone: true }).isValid) {
    throw new SchemaError(PROVIDER, 'Hellmann returned no supported last-change clock');
  }
  const staged = hellmannStage(data.roadStatusFilter);
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown', current_stage: staged?.stage ?? 'unknown',
    current_stage_source: staged?.source ?? 'none', last_status_text: data.roadStatusFilter,
    // The API provides no zone on its observed clock. Do not create an instant or delivery scan.
    last_update: /(?:Z|[+-]\d{2}:\d{2})$/.test(clock) ? clock : null, last_update_local: clock,
    expected_delivery: null, events: [], summary_only: true };
}

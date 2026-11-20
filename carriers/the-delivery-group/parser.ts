import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { tdgStage, tdgWording } from './status.js';

export const PROVIDER = 'The Delivery Group';
export const TDG_TRACKING_URL = 'https://tracking.dockethub.com/Shipment/trackShipment';
export const TDG_MAX_BYTES = 2_000_000;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function normalizeTdgNumber(raw: string): string {
  const number = raw.length <= 80 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{8,30}$/.test(number)) throw new InvalidInputError(PROVIDER, 'TDG tracking takes an alphanumeric shipment reference');
  return number;
}

function clock(date: unknown, time: unknown): string {
  if (typeof date !== 'string' || typeof time !== 'string' || !/^\d{2}\/\d{2}\/20\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new SchemaError(PROVIDER, 'TDG changed a scan clock');
  }
  const raw = date + ' ' + time;
  // UTC validates the calendar; the returned value remains an offset-free wall clock.
  const parsed = DateTime.fromFormat(raw, 'dd/MM/yyyy HH:mm', { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat('dd/MM/yyyy HH:mm') !== raw) throw new SchemaError(PROVIDER, 'TDG returned an invalid scan calendar');
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

export function parseTdg(text: string, raw: string): CarrierResult {
  const number = normalizeTdgNumber(raw);
  if (/_cf_chl_opt|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Attention Required)/i.test(text.slice(0, 64_000))) {
    throw new ChallengeError(PROVIDER, 'DocketHub returned a browser check');
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new SchemaError(PROVIDER, 'DocketHub returned unreadable tracking data'); }
  if (record(data) && data.success === false && Object.keys(data).length === 1) throw new IndeterminateError(PROVIDER, 'TDG did not resolve the reference and delivery postcode');
  if (!record(data) || data.success !== true || !record(data.trackingResults) || !record(data.trackingResults.TrackedShipment)) {
    throw new SchemaError(PROVIDER, 'DocketHub changed its shipment reply');
  }
  const shipment = data.trackingResults.TrackedShipment;
  if (shipment.Carrier !== 'The Delivery Group') throw new IndeterminateError(PROVIDER, 'DocketHub did not confirm TDG ownership');
  if (!Array.isArray(shipment.Items) || shipment.Items.length !== 1 || !record(shipment.Items[0])) {
    throw new IndeterminateError(PROVIDER, 'TDG did not return one independently bound parcel');
  }
  const item = shipment.Items[0];
  if (typeof shipment.CarrierShipmentReference !== 'string' || item.CarrierItemReference !== shipment.CarrierShipmentReference
      || ![shipment.CarrierShipmentReference, shipment.ClientShipmentReference, item.ClientitemReference].some(value => value === number)) {
    throw new IndeterminateError(PROVIDER, 'TDG did not confirm the whole requested parcel or its alias');
  }
  if (shipment.IsTrackingAvailable === false) throw new NoHistoryError(PROVIDER, 'TDG does not publish history for this parcel');
  if (shipment.IsTrackingAvailable !== true || !Array.isArray(item.ItemEvents) || item.ItemEvents.length > 500) {
    throw new SchemaError(PROVIDER, 'TDG changed its parcel history');
  }
  const events: CarrierEvent[] = [];
  for (const value of item.ItemEvents as unknown[]) {
    if (!record(value) || typeof value.Description !== 'string' || value.Description.length > 200) {
      throw new SchemaError(PROVIDER, 'TDG changed a parcel milestone');
    }
    const wording = tdgWording(value.Description, value.OriginalEventMessage);
    const stage = tdgStage(wording);
    if (!stage) throw new SchemaError(PROVIDER, 'TDG returned an unsupported milestone');
    const location = typeof value.Location === 'string' && value.Location.length <= 200 ? value.Location.trim() : '';
    events.push({ time: clock(value.EventDate, value.EventTime), code: value.Description, description: wording,
      stage, stage_source: 'carrier_map', ...(location ? { location } : {}) });
  }
  if (!events.length) throw new NoHistoryError(PROVIDER, 'TDG returned no dated parcel milestones');
  events.sort((a, b) => b.time!.localeCompare(a.time!));
  const latest = events[0]!, stage = tdgStage(latest.description!)!;
  return { status: languageStageStatus(stage), current_stage: stage, current_stage_source: 'carrier_map',
    last_status_text: latest.description, last_update: null, last_update_local: latest.time,
    expected_delivery: null, events: events.slice(0, 100), ...(events.length > 100 ? { history_truncated: true } : {}) };
}

import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { InvalidInputError, NoHistoryError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { plannedEvent, type PlannedEvent } from '../../core/result/planned.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { countryCode } from '../../core/time/index.js';
import { rtb56Entry, rtb56Scans, rtb56Text } from '../yypost/rtb56.js';
import { uofStage } from './status.js';

export const PROVIDER = 'UOF International';

const clearanceAppointment = /^通関予定(?:\s|[0-9]|$)/;

export function normalizeUofNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{4,40}$/.test(number)) throw new InvalidInputError(PROVIDER);
  return number;
}

export function parseUof(payload: unknown, number: string): CarrierResult {
  const { item, rows } = rtb56Entry(payload, number, PROVIDER);
  const scans = rtb56Scans(rows, PROVIDER, (wording) => {
    const stage = uofStage(wording);
    return stage ? { stage, source: 'carrier_map' } : null;
  }, { offsets: true });
  const events: CarrierEvent[] = [];
  const appointments: PlannedEvent[] = [];
  for (const scan of scans) {
    if (clearanceAppointment.test(scan.description ?? '')) {
      const appointment = plannedEvent(scan);
      if (appointment) appointments.push(appointment);
    } else {
      events.push(scan);
    }
  }
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, undefined, { reason: 'listed', plannedEvents: appointments });
  // The summary can lag the newest scan. Read the current stage from the scans.
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  const country = countryCode(rtb56Text(item, 'destination_country', PROVIDER, 8));

  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: staged?.stage_source } : {}),
    last_status_text: newest.description!,
    last_update: newest.time ?? null,
    ...(newest.local_time ? { last_update_local: newest.local_time } : {}),
    ...(country ? { destination_country: country } : {}),
    ...(appointments.length ? { planned_events: appointments } : {}),
    events,
  };
}

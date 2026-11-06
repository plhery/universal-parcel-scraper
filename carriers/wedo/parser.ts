import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ruleFits } from '../../core/detection/rules.js';
import { InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { isRecord } from '../../core/types.js';
import { CARRIER_CATALOG } from '../../generated/catalog.js';
import { ALLEGRO_TRACKING_MAX_ROWS, parseAllegroTrackingHistory } from '../allegro-one/history.js';
import { ALLEGRO_ONE_SCANS } from '../allegro-one/status.js';

export const PROVIDER = 'One by Allegro CZ';
const RULE = CARRIER_CATALOG.wedo.detectionRules[0];
const WORDINGS = new Map(Object.keys(ALLEGRO_ONE_SCANS).map(wording => [normalizeStatusWording(wording), wording]));
const OFFSET_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/;

/** Use the existing Czech label rule, without accepting Polish Allegro labels or piece suffixes. */
export function normalizeWedoNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!RULE || !ruleFits(RULE, number, raw)) {
    throw new InvalidInputError(PROVIDER, 'The number is outside the supported Czech WeDo label scope');
  }
  return number;
}

/** The guest reply has no identifier; retrieval binds its exact whole-number query and national route. */
export function parseWedo(payload: unknown, raw: string): CarrierResult {
  normalizeWedoNumber(raw);
  if (!isRecord(payload) || Object.keys(payload).some(key => key !== 'status')) {
    throw new SchemaError(PROVIDER, 'The Czech tracker changed its status-list reply');
  }
  let partial = false;
  const rows = payload.status;
  const projected = Array.isArray(rows) && rows.length <= ALLEGRO_TRACKING_MAX_ROWS
    ? rows.map((row: unknown) => {
      if (!isRecord(row) || typeof row.description !== 'string') return row;
      if (typeof row.eventTimestamp !== 'string' || !OFFSET_CLOCK.test(row.eventTimestamp.trim())) {
        throw new SchemaError(PROVIDER, 'The Czech tracker returned a scan without a valid stated offset');
      }
      if (!row.description.trim() || row.description.length > 1000) throw new SchemaError(PROVIDER, 'The Czech tracker returned invalid wording');
      const description = WORDINGS.get(normalizeStatusWording(row.description));
      if (!description) partial = true;
      // Only standard logistics wording leaves the page: unknown prose can name a recipient.
      return { eventTimestamp: row.eventTimestamp, description: description ?? 'Tracking update' };
    }) : rows;
  const result = parseAllegroTrackingHistory({ status: projected }, PROVIDER, () => {
    throw new NoHistoryError(PROVIDER, 'The Czech tracker has no retained scans for this number');
  }, true);
  return partial ? { ...result, history_truncated: true } : result;
}

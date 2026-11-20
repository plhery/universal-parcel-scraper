import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'hecny-shipping';

function readProps(html: string) {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(html)) {
    throw new ChallengeError(provider, 'Hecny requires verification');
  }
  const $ = load(html);
  const data = $('#app[data-page]').attr('data-page');
  if (!data) throw new SchemaError(provider, 'Hecny omitted the tracking page data');
  let page: unknown;
  try {
    page = JSON.parse(data);
  } catch {
    throw new SchemaError(provider, 'Hecny returned invalid tracking page data');
  }
  if (!isRecord(page) || page.component !== 'TrackAndTrace/Index' || !isRecord(page.props)) {
    throw new SchemaError(provider, 'Hecny changed the tracking page component');
  }
  return page.props;
}

function isWallTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)
    && DateTime.fromISO(value, { zone: 'utc' }).isValid;
}

export function parseTrackingPage(html: string, number: string): CarrierResult {
  const { searchedKeyword, tracking, errors, message } = readProps(html);
  if (searchedKeyword !== number || !Array.isArray(tracking) || !isRecord(errors)
      || Object.keys(errors).length > 0 || message !== null) {
    throw new SchemaError(provider, 'Hecny did not return a successful response for the requested bill');
  }
  if (tracking.length === 0) throw new NotFoundError(provider);
  const matched = tracking.filter(row => isRecord(row) && Array.isArray(row.doc_no) && row.doc_no.includes(number));
  if (matched.length === 0) throw new IndeterminateError(provider, 'Hecny answered for a different house bill of lading');
  if (matched.length !== 1) {
    throw new IndeterminateError(provider, 'Hecny returned multiple records for the house bill', { reason: 'listed' });
  }
  const row: unknown = matched[0];
  if (!isRecord(row) || typeof row.ContainerNo !== 'string' || !/^[A-Z]{4}\d{7}$/.test(row.ContainerNo)
      || !Array.isArray(row.eventDesc)) {
    throw new SchemaError(provider, 'Hecny omitted the container or its events');
  }

  const ordered: { clock: string; ordering: number; event: CarrierEvent }[] = [];
  for (const scan of row.eventDesc as unknown[]) {
    if (!isRecord(scan)) throw new SchemaError(provider, 'Hecny returned an invalid movement');
    // This matches the tracker, which omits movements with no sequence number.
    if (scan.ordering === null) continue;
    const { event_on: clock, event_on_gmt: localTime, event_desc: wording, event_code: code, event_at_name: place, ordering } = scan;
    if (!isWallTime(clock) || !isWallTime(localTime) || typeof ordering !== 'number' || !Number.isSafeInteger(ordering)
        || typeof wording !== 'string' || !wording.trim() || typeof code !== 'string' || !code.trim()) {
      throw new SchemaError(provider, 'Hecny returned an invalid movement');
    }
    const description = wording.trim();
    const location = typeof place === 'string' ? place.trim() : '';
    const stage = scanStage(code, description);
    ordered.push({ clock, ordering, event: {
      local_time: localTime, description, provider_code: code,
      ...(location && { location }), ...(stage && { stage, stage_source: 'carrier_map' }),
    } });
  }
  ordered.sort((left, right) => right.clock.localeCompare(left.clock) || right.ordering - left.ordering);
  const events = ordered.map(({ event }) => event);
  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'Hecny listed the container without movements', { reason: 'listed' });
  const stage = events.some(event => event.stage === 'in_transit') ? 'in_transit' : undefined;
  return {
    status: stage ?? 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

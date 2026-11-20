import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { stageForCode } from './status.js';

export const provider = 'hop-envios';

interface Tracking {
  tracking_nro?: unknown;
  trackings?: unknown;
  tracking_history?: { history?: unknown };
  history?: unknown;
}

export function parseTracking(html: string, number: string): CarrierResult {
  const $ = load(html);
  const state = $('script#__NEXT_DATA__[type="application/json"]');
  if (state.length !== 1) {
    if (/cf-chl-|<title>\s*(?:Just a moment|Access Denied)/i.test(html)) {
      throw new ChallengeError(provider, 'HOP requires verification');
    }
    throw new SchemaError(provider, 'Missing HOP tracking page data');
  }
  let page: { page?: unknown; props?: { pageProps?: { code?: unknown; trackingData?: Tracking | null } } };
  try {
    page = JSON.parse(state.text()) as typeof page;
  } catch (cause) {
    throw new SchemaError(provider, 'Malformed HOP tracking page data', { cause });
  }
  if (page?.page !== '/segui-tu-envio') throw new SchemaError(provider, 'Unexpected HOP result page');
  const data = page.props?.pageProps;
  if (typeof data?.code !== 'string' || data.code.toUpperCase() !== number) {
    throw new IndeterminateError(provider, 'HOP answered for another code');
  }
  if (data.trackingData === null && $('h3').toArray().some(node => $(node).text().includes('Código no encontrado'))) {
    throw new NotFoundError(provider);
  }
  const shipment = data.trackingData;
  if (!shipment || typeof shipment.tracking_nro !== 'string') throw new SchemaError(provider, 'Missing HOP shipment');
  if (shipment.tracking_nro.toUpperCase() !== number) throw new IndeterminateError(provider, 'HOP answered for another shipment');
  // The site displays the first populated list, using both legacy and current event fields.
  const candidates = [shipment.trackings, shipment.tracking_history?.history, shipment.history].filter(Array.isArray);
  if (!candidates.length) throw new SchemaError(provider, 'Missing HOP history');
  const rows = candidates.find(list => list.length);
  if (!rows) throw new NoHistoryError(provider);
  const scans = rows.map((row: {
    guide_code?: unknown; state?: unknown; code?: unknown; description?: unknown; status_datetime?: unknown;
    date?: unknown; datetime?: unknown; created_at?: unknown;
  } | null) => {
    if (!row || (row.guide_code != null && row.guide_code !== number)) {
      throw new IndeterminateError(provider, 'HOP history includes another shipment');
    }
    const rawDate = row.status_datetime ?? row.date ?? row.datetime ?? row.created_at;
    const date = typeof rawDate === 'object' && rawDate !== null && 'date' in rawDate ? rawDate.date : rawDate;
    const code = row.state ?? row.code;
    const description = row.description;
    if (typeof date !== 'string' || typeof code !== 'string' || typeof description !== 'string' || !description.trim()) {
      throw new SchemaError(provider, 'Invalid HOP history row');
    }
    const iso = date.replace(' ', 'T');
    const clock = DateTime.fromISO(iso, { zone: 'utc', setZone: true });
    if (!clock.isValid || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) throw new SchemaError(provider, 'Invalid HOP scan clock');
    const instant = explicitOffsetTime(iso);
    const stage = stageForCode(code);
    const event: CarrierEvent = {
      description: description.trim(), provider_code: code,
      ...(instant ? { time: instant.iso } : { local_time: clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") }),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}),
    };
    return { event, stage, timestamp: clock.toMillis() };
  }).sort((a, b) => b.timestamp - a.timestamp);
  const latest = scans[0]!.event;
  const stage = scans.find(scan => scan.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: latest.description,
    ...(latest.time ? { last_update: latest.time } : { last_update_local: latest.local_time }),
    events: scans.map(scan => scan.event),
  };
}

import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { isRecord } from '../../core/types.js';
import { scanStage } from './status.js';

export const provider = 'atlantic-container-line';

function parseGrid(html: string, id: 'gridContainer' | 'popupGridContainer'): { rows: unknown[]; script: string } {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied|Security Check)/i.test(html)) {
    throw new ChallengeError(provider, 'ACL requires verification');
  }
  const $ = load(html);
  if ($(`#${id}`).length !== 1) throw new SchemaError(provider, 'ACL omitted the tracking grid');
  const scripts = $('script:not([src])').map((_, element) => $(element).text()).get()
    .filter(script => script.includes(`$("#${id}").dxDataGrid(`));
  const script = scripts.length === 1 ? scripts[0]! : '';
  const stores = [...script.matchAll(/"dataSource":\{"store":new DevExpress\.data\.ArrayStore\(\{\s*"data":\s*(\[[\s\S]*?\])\s*\}\)\}/g)];
  if (stores.length !== 1) throw new SchemaError(provider, 'ACL omitted the tracking grid data');
  let rows: unknown;
  try {
    rows = JSON.parse(stores[0]![1]!);
  } catch {
    throw new SchemaError(provider, 'ACL returned invalid tracking grid data');
  }
  if (!Array.isArray(rows)) throw new SchemaError(provider, 'ACL returned invalid tracking rows');
  return { rows, script };
}

export function parseShipment(html: string, shipment: string): string {
  const { rows, script } = parseGrid(html, 'gridContainer');
  if (rows.length === 0 && script.includes('"noDataText":"No Shipments or Containers found matching your search"')) {
    throw new NotFoundError(provider);
  }
  const matched = rows.filter(row => isRecord(row) && row.ShipmentNumber === shipment);
  if (matched.length === 0) throw new IndeterminateError(provider, 'ACL returned no row bound to the shipment');
  if (matched.length !== 1) {
    throw new IndeterminateError(provider, 'ACL returned multiple containers for the shipment', { reason: 'listed' });
  }
  const row: unknown = matched[0];
  if (!isRecord(row) || row.IsCargoIdValid !== true || typeof row.CargoId !== 'string'
      || !/^[A-Z]{4}\d{7}$/.test(row.CargoId)) {
    throw new IndeterminateError(provider, 'ACL listed the shipment without a container identifier', { reason: 'listed' });
  }
  return row.CargoId;
}

export function parseMovements(html: string, shipment: string, container: string): CarrierResult {
  const { rows } = parseGrid(html, 'popupGridContainer');
  const events = rows.map(row => {
    if (!isRecord(row)) throw new SchemaError(provider, 'ACL returned an invalid container movement');
    if (row.ShipmentNumber !== shipment || row.CargoId !== container) {
      throw new IndeterminateError(provider, 'ACL answered for a different shipment or container');
    }
    const { TrackingTimestamp: clock, TrackingInfo: status, TrackingLocation: place } = row;
    if (typeof clock !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(clock)
        || !DateTime.fromISO(clock, { zone: 'utc' }).isValid || typeof status !== 'string' || !status.trim()) {
      throw new SchemaError(provider, 'ACL returned an invalid container movement');
    }
    const description = status.trim();
    const location = typeof place === 'string' ? place.trim() : '';
    const stage = scanStage(description);
    return {
      local_time: clock, description, ...(location && { location }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'ACL listed the container without movements', { reason: 'listed' });
  const stage = events.find(event => event.stage)?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update_local: latest.local_time, events,
  };
}

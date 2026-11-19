import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { isEnRoute, scanStage } from './status.js';

const provider = 'moran-transportation';
export const maxBytes = 256 * 1024;
const place = /^\p{L}[\p{L} .'-]{0,59}, [A-Z]{2}$/u;

function field(node: XmlNode, name: string): string {
  const fields = node.children.filter(child => child.name === name && !child.uri);
  if (fields.length > 1 || fields[0]?.children.length) throw new SchemaError(provider, `Invalid ${name}`);
  return fields[0]?.text.trim() ?? '';
}

export function parseTracking(xml: string, number: string, httpStatus: number): CarrierResult {
  if (/cf-chl|_Incapsula_Resource|<title>\s*(?:Just a moment|Access Denied)/i.test(xml)) {
    throw new ChallengeError(provider, 'Moran tracker requires verification');
  }
  const root = xmlDocument(xml, maxBytes);
  if (httpStatus !== 200 || !root || root.uri) throw new SchemaError(provider, 'Invalid shipment trace');
  if (root.name === 'error' && field(root, 'errormessage') === `Invalid pronumber ${number}`) throw new NotFoundError(provider);
  if (root.name !== 'protrace') throw new SchemaError(provider, 'Unexpected shipment trace');
  if (field(root, 'pronumb') !== number) throw new IndeterminateError(provider, 'Moran answered for another PRO');

  const histories = root.children.filter(child => child.name === 'shiphists' && !child.uri);
  if (histories.length !== 1) throw new IndeterminateError(provider, 'Moran returned no usable history');
  const events: CarrierEvent[] = histories[0]!.children.map(row => {
    if (row.name !== 'shiphist' || row.uri) throw new SchemaError(provider, 'Invalid history row');
    const description = field(row, 'histcode');
    const day = field(row, 'histdate');
    const time = field(row, 'histtime');
    const clock = DateTime.fromISO(/\d/.test(time) ? `${day}T${time}` : day, { zone: 'utc' });
    if (!description || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !clock.isValid) throw new SchemaError(provider, 'Invalid history event');
    const local_time = /\d/.test(time) ? clock.toFormat("yyyy-MM-dd'T'HH:mm:ss") : day;
    const remark = field(row, 'histremarks');
    const stage = scanStage(description);
    return { description, local_time, ...(place.test(remark) ? { location: remark } : {}),
      ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  }).sort((left, right) => right.local_time.localeCompare(left.local_time));

  let previous: string | undefined;
  for (const event of [...events].reverse()) {
    if (previous === 'out_for_delivery' && isEnRoute(event.description!)) event.stage = previous;
    previous = event.stage ?? previous;
  }
  const newest = events[0];
  if (!newest) throw new NoHistoryError(provider);
  const lead = events.find(event => event.stage);
  const delivered = field(root, 'prodelivered').toLowerCase() === 'yes';
  const stage = delivered ? 'delivered' : lead?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: delivered ? 'carrier_map' : lead!.stage_source } : {}),
    last_status_text: newest.description!, last_update_local: newest.local_time!, events,
  };
}

import { isFrontierCaReference } from '../../core/detection/frontierCa.js';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/text.js';
import { xmlDocument, type XmlNode } from '../../core/transport/xml.js';
import { frontierCaStage } from './status.js';

export const PROVIDER = 'Frontier Courier';
export function normalizeFrontierCaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{5,40}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Frontier needs a PRO');
  if (!isFrontierCaReference(number)) throw new NoHistoryError(PROVIDER, 'The guest trace supports Frontier PROs', { reason: 'unsupported_reference' });
  return number;
}
export function frontierCaUrl(number: string): string { return `https://tracking.carrierlogistics.com/scripts/fscf.pol/protracexml.htm?${new URLSearchParams({ pronum: normalizeFrontierCaNumber(number) })}`; }
function elements(node: XmlNode, name: string): XmlNode[] { return node.children.filter(child => child.name === name && child.uri === ''); }
function field(node: XmlNode, name: string, max = 100): string {
  const values = elements(node, name);
  if (values.length > 1 || values[0]?.children.length || (values[0]?.text.length ?? 0) > max) throw new SchemaError(PROVIDER, 'Frontier returned an invalid trace field');
  return clean(values[0]?.text ?? '', max);
}
function localClock(day: string, time: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match || !calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new SchemaError(PROVIDER, 'Frontier returned an invalid scan clock');
  return `${day}T${time}:00`;
}
export function parseFrontierCa(xml: string, raw: string): CarrierResult {
  const number = normalizeFrontierCaNumber(raw), root = xmlDocument(xml, 1024 * 1024);
  if (!root || root.uri !== '' || !['protrace', 'error'].includes(root.name)) {
    if (/WebSpeed error|WebSpeed Agent/i.test(xml)) throw new IndeterminateError(PROVIDER, 'Frontier could not run its trace');
    throw new SchemaError(PROVIDER, 'Frontier returned no trace document');
  }
  if (root.name === 'error') {
    if (root.children.length === 1 && elements(root, 'errormessage').length === 1
      && field(root, 'errormessage') === `Invalid pronumber ${number}`) throw new NotFoundError(PROVIDER);
    throw new SchemaError(PROVIDER, 'Frontier returned an unbound trace error');
  }
  if (elements(root, 'error').length || field(root, 'pronumb', 32) !== number) throw new SchemaError(PROVIDER, 'Frontier returned another shipment or a mixed error');
  const lifecycle = field(root, 'lifecycle', 100), code = field(root, 'lifecyclestatuscode', 16), delivered = field(root, 'prodelivered', 8);
  if (/quote/i.test(lifecycle)) throw new NoHistoryError(PROVIDER, 'A rate quote is not a shipment', { reason: 'unsupported_service' });
  const groups = elements(root, 'shiphists');
  if (groups.length !== 1 || groups[0]!.children.some(child => child.name !== 'shiphist' || child.uri !== '')) throw new SchemaError(PROVIDER, 'Frontier changed its history envelope');
  const rows = groups[0]!.children;
  if (rows.length > 500) throw new SchemaError(PROVIDER, 'Frontier returned too many scans');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'Frontier returned no dated history');
  const events: CarrierEvent[] = [], seen = new Set<string>();
  for (const row of rows) {
    const providerCode = field(row, 'histcode', 100), remarks = field(row, 'histremarks', 300);
    if (!providerCode || /[<>@]|https?:|\d{7,}|\b(?:signed|recipient|phone)\b/i.test(providerCode)) throw new SchemaError(PROVIDER, 'Frontier returned no logistics description');
    const stage = frontierCaStage(providerCode, providerCode);
    const location = /^\p{L}[\p{L} .'-]{0,59}, [A-Z]{2}$/u.test(remarks) ? remarks : '';
    const event: CarrierEvent = { local_time: localClock(field(row, 'histdate', 32), field(row, 'histtime', 16)),
      provider_code: providerCode, description: providerCode, ...(location ? { location } : {}), ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event); if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  const headline = frontierCaStage(code === '80' ? code : null, lifecycle), scanned = events.find(event => event.stage), newest = events[0]!;
  if (code === '80' && headline !== 'delivered') throw new SchemaError(PROVIDER, 'Frontier returned a contradictory lifecycle code');
  if (headline === 'delivered' && (delivered.toLowerCase() !== 'yes' || scanned?.stage !== 'delivered')) throw new SchemaError(PROVIDER, 'Frontier returned contradictory delivery states');
  if (delivered.toLowerCase() === 'yes' && headline !== 'delivered') throw new SchemaError(PROVIDER, 'Frontier returned a contradictory delivery lifecycle');
  if (headline === 'returned' && scanned?.stage !== 'returned') throw new SchemaError(PROVIDER, 'Frontier returned contradictory return states');
  if (!headline && scanned?.stage === 'delivered') throw new NoHistoryError(PROVIDER, 'Frontier did not settle its current lifecycle', { reason: 'unsupported_status' });
  return { status: headline ? languageStageStatus(headline) : 'unknown', ...(headline ? { current_stage: headline, current_stage_source: 'carrier_map' } : {}),
    ...(code ? { provider_code: code } : {}), last_status_text: lifecycle || newest.description, last_update: null,
    last_update_local: newest.local_time, expected_delivery: null,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}

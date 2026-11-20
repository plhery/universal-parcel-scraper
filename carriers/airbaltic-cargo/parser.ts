import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { routeEndpoint, scanStages } from './status.js';

export const provider = 'airbaltic-cargo';

// Nuxt stores values once in a serialized array and refers to them by index.
function valueAt(payload: unknown[], address: unknown): unknown {
  return typeof address === 'number' && Number.isSafeInteger(address) && address >= 0
    ? payload[address]
    : undefined;
}

export function parseTracking(body: string, prefix: string, serial: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i.test(body)) {
    throw new ChallengeError(provider, 'airBaltic requires verification');
  }
  const $ = load(body);
  const waybill = prefix + '-' + serial;
  const headings = $('h1').toArray().map(node => clean($(node).text()));
  if (headings.includes('Could not find AWB ' + waybill)) throw new NotFoundError(provider);
  const identity = headings.find(heading => /^Air waybill Nr\. \d{3}-\d{8}$/.test(heading));
  if (!identity) throw new SchemaError(provider, 'airBaltic omitted its air waybill heading');
  if (identity !== 'Air waybill Nr. ' + waybill) {
    throw new IndeterminateError(provider, 'airBaltic returned a different air waybill');
  }

  let payload: unknown;
  try {
    payload = JSON.parse($('script#__NUXT_DATA__[type="application/json"]').text());
  } catch {
    throw new SchemaError(provider, 'airBaltic omitted its structured cargo history');
  }
  if (!Array.isArray(payload)) throw new SchemaError(provider, 'airBaltic returned an invalid cargo payload');
  const cargo = payload.filter((row: unknown): row is Record<string, unknown> =>
    isRecord(row) && 'serialNumber' in row && 'cargoEvents' in row
    && valueAt(payload, row.serialNumber) === serial);
  if (cargo.length !== 1) throw new SchemaError(provider, 'airBaltic did not identify one matching cargo record');
  const references = valueAt(payload, cargo[0]!.cargoEvents);
  if (!Array.isArray(references)) throw new SchemaError(provider, 'airBaltic omitted the cargo movement list');

  const events = references.map(address => {
    const row = valueAt(payload, address);
    if (!isRecord(row)) throw new SchemaError(provider, 'airBaltic returned an invalid cargo movement');
    const description = clean(valueAt(payload, row.status));
    const seconds = valueAt(payload, row.originalEventDateTime);
    if (!description || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
      throw new SchemaError(provider, 'airBaltic returned invalid movement text or time');
    }
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.valueOf())) throw new SchemaError(provider, 'airBaltic returned an invalid movement instant');
    const stage = scanStages.get(description);
    const endpoint = routeEndpoint.get(description);
    const airport = endpoint && clean(valueAt(payload, row[endpoint]));
    return {
      time: date.toISOString(),
      description,
      ...(airport && /^[A-Z]{3}$/.test(airport) && { location: airport }),
      ...(stage && { stage, stage_source: 'carrier_map' }),
    };
  }).sort((first, second) => second.time.localeCompare(first.time));

  const latest = events[0];
  if (!latest) throw new IndeterminateError(provider, 'airBaltic listed the waybill without dated movements', { reason: 'listed' });
  const stage = latest.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage && { current_stage: stage, current_stage_source: 'carrier_map' }),
    last_status_text: latest.description, last_update: latest.time, events,
  };
}

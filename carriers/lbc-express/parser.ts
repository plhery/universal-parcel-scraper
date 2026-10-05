import { load } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { IndeterminateError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import type { ClassifiedStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';

export function normalizeLbcNumber(raw: string): string {
  const number = normalizeTrackingNumber(raw);
  if (!/^\d{12}$/.test(number)) throw new InvalidInputError('lbc-express', 'LBC requires a twelve-digit tracking number');
  return number;
}

function classify(description: string): ClassifiedStatus | undefined {
  if (description === 'Delivered') return { status: 'delivered', stage: 'delivered' };
  if (description === 'Please expect delivery within the day.') return { status: 'out_for_delivery', stage: 'out_for_delivery' };
  if (/^Shipment has been accepted at\s+.+\.$/.test(description)) return { status: 'in_transit', stage: 'accepted' };
  if (/^Shipment has been received at\s+.+\.$/.test(description)
    || /^Shipment is en route to\s+.+\./.test(description)) return { status: 'in_transit', stage: 'in_transit' };
  return undefined;
}

export function parseLbc(html: string, raw: string): CarrierResult {
  const number = normalizeLbcNumber(raw);
  if (typeof html !== 'string' || new TextEncoder().encode(html).byteLength > 1_000_000) throw new SchemaError('lbc-express', 'LBC returned excessive tracking data');
  const $ = load(html);
  const identity = $('#inputTrackingSearchForm');
  if (identity.length !== 1 || identity.attr('value') !== number) throw new SchemaError('lbc-express', 'LBC returned a different or ambiguous shipment');
  const rows = $('.mobile-tracking-list');
  // The official empty result echoes the submitted number but supplies no
  // explicit absence decision. Neither that echo nor HTTP 200 proves absence.
  if (!rows.length) throw new IndeterminateError('lbc-express', 'LBC returned no shipment scans');
  if (rows.length > 500) throw new SchemaError('lbc-express', 'LBC returned too many shipment scans');
  const events: CarrierEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows.toArray()) {
    const descriptionNode = $(row).find('.mobile-tracking-details');
    const dayNode = $(row).find('.mobile-tracking-timedate');
    if (descriptionNode.length !== 1 || dayNode.length !== 1) throw new SchemaError('lbc-express', 'LBC shipment scan layout changed');
    const rawDescription = clean(descriptionNode.text(), 1000);
    if (!rawDescription) throw new SchemaError('lbc-express', 'LBC returned an empty shipment scan');
    // Delivery descriptions contain the recipient. Retain the milestone,
    // never the name or the original text as a secondary provider field.
    const delivered = /^Delivered to .+ on \d{1,2}\/\d{1,2}\/\d{4}\.$/i.test(rawDescription);
    const description = delivered ? 'Delivered' : /^Delivered to\b/i.test(rawDescription) ? 'Delivery update' : rawDescription;
    const day = clean(dayNode.text(), 80);
    const mapped = classify(description);
    const event: CarrierEvent = { description, ...(day ? { provider_time_text: day } : {}),
      ...(mapped ? { stage: mapped.stage, stage_source: 'carrier_map' } : {}) };
    const key = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  // The rendered history is current first. Calendar dates provide no time of
  // day, so preserve that order and never synthesize a midnight instant.
  const current = events[0]!;
  const mapped = classify(current.description!);
  return { status: mapped?.status ?? 'unknown', ...(mapped ? { current_stage: mapped.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: current.description, last_update: null, timezone: 'Asia/Manila', events: events.slice(0, 100) };
}

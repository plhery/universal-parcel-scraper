import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { clean } from '../../core/transport/index.js';
import { isRecord } from '../../core/types.js';
import { fastwayCodeStage, HANDOVER_WORDING } from './status.js';

export const PROVIDER = 'Fastway South Africa';
export const CALLBACK = 'parcelTracking';

const MAX_ROWS = 500;
const CLOCK = 'yyyy-MM-dd HH:mm:ss';

export function fastwayLabel(raw: string): string {
  const number = raw.length <= 64 ? raw.replace(/\s+/g, '').toUpperCase() : '';
  if (!/^[A-Z0-9]{1,25}$/.test(number)) {
    throw new InvalidInputError(PROVIDER, 'Fastway takes one label or calling card number');
  }
  return number;
}

function readReply(body: string): unknown {
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required)|cf-chl-|g-recaptcha|cf-turnstile/i.test(body)) {
    throw new ChallengeError(PROVIDER, 'Fastway returned a verification page');
  }
  const reply = body.trim();
  const prefix = `${CALLBACK}(`;
  if (!reply.startsWith(prefix) || !reply.endsWith(');')) throw new SchemaError(PROVIDER, 'Fastway returned an invalid JSONP response');
  try {
    return JSON.parse(reply.slice(prefix.length, -2));
  } catch {
    throw new SchemaError(PROVIDER, 'Fastway tracking payload was malformed');
  }
}

type Scan = CarrierEvent & { local_time: string; description: string; provider_code: string; stage?: Stage };

export function parseFastwayReply(body: string, number: string): CarrierResult {
  const reply = readReply(body);
  if (!isRecord(reply)) throw new SchemaError(PROVIDER, 'Fastway returned no tracking object');
  if (typeof reply.error === 'string') {
    if (reply.result === undefined && reply.error === `Label '${number}' does not have any scans.`) throw new NoHistoryError(PROVIDER);
    throw new IndeterminateError(PROVIDER, 'Fastway returned a tracking error');
  }
  if (typeof reply.result !== 'string') throw new SchemaError(PROVIDER, 'Fastway returned no tracking HTML');

  const $ = load(reply.result);
  const heading = $('#trackheader').children('[id="track_labelnumber"]').filter((_, node) =>
    $(node).text().trim().startsWith('Result for label number:'));
  const label = heading.children('.track_number');
  if (heading.length !== 1 || label.length !== 1) throw new SchemaError(PROVIDER, 'Fastway returned no unique label number');
  if (label.text().trim().toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Fastway returned another label');

  const rows = $('.track_row').toArray();
  if (rows.length > MAX_ROWS) throw new SchemaError(PROVIDER, 'Fastway returned too many scans');
  if (!rows.length) throw new NoHistoryError(PROVIDER, 'Fastway lists the label without scans', { reason: 'listed' });

  const scans = new Map<string, Scan>();
  for (const node of rows) {
    const row = $(node);
    const written = row.attr('data-scandate') ?? '';
    const date = DateTime.fromFormat(written, CLOCK, { zone: 'UTC' });
    const code = row.attr('data-scanstatus');
    const wording = clean(row.find('p.status_description').text(), 400) || clean(row.find('p.status_heading').text(), 400);
    const location = clean(row.children('[id="track_column4"]').text(), 160);
    if (!date.isValid || date.toFormat(CLOCK) !== written || !code || !/^[A-Z0-9]{1,12}$/.test(code) || !wording) {
      throw new SchemaError(PROVIDER, 'Fastway returned an invalid scan');
    }
    const local_time = date.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const scan = { local_time, provider_code: code, description: wording, ...(location ? { location } : {}) };
    scans.set(JSON.stringify([local_time, code, wording, location]), scan);
  }

  let inNetwork = false;
  const events: Scan[] = [...scans.values()].sort((a, b) => a.local_time.localeCompare(b.local_time)).map(scan => {
    const code = scan.provider_code;
    let stage = fastwayCodeStage(code);
    // A pickup can also be an internal handoff after the parcel reaches a depot.
    if (code === 'PPP' && inNetwork) stage = 'in_transit';
    // A regional "signature obtained" scan alone can be the on-forwarder's receipt.
    if (code === 'YES' && scan.description !== HANDOVER_WORDING) stage = undefined;
    if (stage === 'accepted' || stage === 'in_transit' || stage === 'out_for_delivery') inNetwork = true;
    return { ...scan, ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  }).reverse();
  const newest = events[0]!;
  return {
    status: newest.stage ? languageStageStatus(newest.stage) : 'unknown',
    ...(newest.stage ? { current_stage: newest.stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time, events,
  };
}

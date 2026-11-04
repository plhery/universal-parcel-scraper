import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/normalize.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { clean } from '../../core/transport/text.js';
import { wahanaStage } from './status.js';

export const PROVIDER = 'Wahana Express';
export const WAHANA_MAX_BYTES = 512 * 1024;
const BLOCKED = /_cf_chl_opt|cf-chl-|cf-turnstile|<title>\s*(?:Just a moment|Attention Required|Access Denied)|Incapsula incident|Request unsuccessful|verify (?:that )?you are human|403 Forbidden/i;

/** Lookup validation only: eight characters do not establish carrier ownership. */
export function normalizeWahanaNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!/^[A-Z0-9]{8}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Wahana needs its eight-character resi');
  return number;
}

function clock(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new SchemaError(PROVIDER, 'Wahana changed its scan clock');
  const local = value.replace(' ', 'T');
  const date = DateTime.fromISO(local, { zone: 'UTC' });
  if (!date.isValid || date.toFormat("yyyy-MM-dd'T'HH:mm:ss") !== local) throw new SchemaError(PROVIDER, 'Wahana returned an invalid scan calendar');
  return local;
}

/** Only a result of a challenge submission is parsed; an unsubmitted search is no negative control. */
export function parseWahana(html: string, raw: string): CarrierResult {
  const number = normalizeWahanaNumber(raw);
  if (new TextEncoder().encode(html).byteLength > WAHANA_MAX_BYTES) throw new SchemaError(PROVIDER, 'Wahana returned an oversized page');
  if (BLOCKED.test(html)) throw new ChallengeError(PROVIDER, 'Wahana returned browser verification');
  const $ = load(html), panel = $('#lacakkirimanresult'), accordion = panel.children('#accordion');
  if (panel.length !== 1 || accordion.length !== 1) throw new SchemaError(PROVIDER, 'Wahana returned no unique result panel');
  const cards = accordion.children('.card.block-lacak');
  const notice = clean(accordion.text(), 1000);
  if (!cards.length) {
    if (notice === 'Captcha tidak sesuai') throw new ChallengeError(PROVIDER, 'Wahana refused image verification', { reason: 'verification_rejected' });
    if (notice === 'Resi tidak ditemukan') throw new NoHistoryError(PROVIDER, 'Wahana has no available history for this resi', { reason: 'portal_not_found' });
    throw new IndeterminateError(PROVIDER, 'Wahana returned an inconclusive lookup');
  }
  if (cards.length !== 1 || accordion.find('.card.block-lacak').length !== 1) throw new SchemaError(PROVIDER, 'Wahana returned multiple shipment cards');
  const card = cards.eq(0), header = card.children('.card-header'), body = card.children('.card-body');
  const identity = header.find('.font-size22.font-bold');
  if (header.length !== 1 || body.length !== 1 || identity.length !== 1 || identity.text().trim() !== number
    || clean(identity.prev().text()) !== 'Nomor Resi') throw new SchemaError(PROVIDER, 'Wahana returned another shipment or changed its identity');
  const summaryRows = header.children('.row').eq(1).find('.row').filter((_, row) => $(row).children('.list-left').length === 1);
  if (summaryRows.length !== 1) throw new SchemaError(PROVIDER, 'Wahana changed its current-status row');
  const rows = [...summaryRows.toArray(), ...body.find('.row').filter((_, row) => $(row).children('.list-left').length === 1).toArray()];
  if (rows.length > 501) throw new SchemaError(PROVIDER, 'Wahana returned excessive history');
  const seen = new Set<string>(), events: CarrierEvent[] = [];
  for (const row of rows) {
    const content = $(row).children('.list-left').next();
    if (content.length !== 1) throw new SchemaError(PROVIDER, 'Wahana changed a history row');
    const descriptionCell = content.children('.font-size14.font-bold'), timeCell = content.children('.font-size12.font-light');
    // The page has an empty decorative row before its dated scans.
    if (!descriptionCell.length && !timeCell.length && !clean(content.text())) continue;
    if (descriptionCell.length !== 1 || timeCell.length !== 1 || descriptionCell.text().length > 2000) throw new SchemaError(PROVIDER, 'Wahana returned a malformed scan');
    let description = clean(descriptionCell.text(), 1000);
    if (!description) throw new SchemaError(PROVIDER, 'Wahana returned an unnamed scan');
    if (/^Diterima oleh\b/i.test(description)) description = 'Diterima oleh penerima';
    else description = description.replace(/^((?:Dalam proses|Proses) pengantaran oleh kurir)\b[\s\S]*$/i, '$1');
    const local = clock(clean(timeCell.text(), 80));
    const key = JSON.stringify([local, description]);
    if (seen.has(key)) continue;
    seen.add(key);
    const staged = wahanaStage(description);
    events.push({ local_time: local, description, ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}) });
  }
  const newest = events[0];
  if (!newest) throw new NoHistoryError(PROVIDER, 'Wahana returned no dated shipment history');
  const staged = wahanaStage(newest.description!);
  return { status: staged ? languageStageStatus(staged.stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: newest.description, last_update: null, last_update_local: newest.local_time,
    ...(events.length > 100 ? { history_truncated: true } : {}), events: events.slice(0, 100) };
}

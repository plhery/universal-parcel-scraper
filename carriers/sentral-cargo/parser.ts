import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { explicitOffsetTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';

export const PROVIDER = 'Sentral Cargo';

const BADGES = new Map<string, Stage>([['delivered', 'delivered'], ['on process', 'in_transit']]);
const STATUS_PREFIXES: ReadonlyArray<readonly [RegExp, Stage]> = [
  [/^Paket dipickup oleh kantor\b/i, 'accepted'],
  [/^Paket sedang dikirimkan ke\b/i, 'out_for_delivery'],
  [/^Antar sebagian\b/i, 'in_transit'],
  [/^Paket (?:sudah diterima oleh kantor|dikirim dari)\b/i, 'in_transit'],
];
const DEPOT = /^Paket (?:sudah diterima oleh kantor|dipickup oleh kantor|dikirim dari) \[([^\]]+)\]/i;

type Scan = CarrierEvent & { time: string; description: string; stage?: Stage };

export function sentralReceiptNumber(raw: string): string {
  const number = raw.length <= 40 ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{1,20}$/.test(number)) throw new InvalidInputError(PROVIDER, 'Sentral Cargo takes one receipt number of up to 20 letters and digits');
  return number;
}

export function parseSentralTracking(html: string, number: string): CarrierResult {
  if (/<title>\s*(?:Just a moment|Access Denied|Attention Required)|cf-chl-|g-recaptcha|cf-turnstile/i.test(html)) {
    throw new ChallengeError(PROVIDER, 'Sentral Cargo returned a verification page');
  }
  const $ = load(html);
  const result = $('main [data-testid="tracking-result"]');
  if (result.length === 0) {
    const missing = $('main [role="alert"] > p').toArray().some(node =>
      clean($(node).text(), 250) === `Nomor resi ${number} tidak ditemukan. Periksa kembali nomor resi Anda.`);
    if (missing) throw new NotFoundError(PROVIDER);
  }
  const heading = result.find('#tracking-title');
  const badge = result.find('[data-testid="tracking-status"]');
  if (result.length !== 1 || heading.length !== 1 || badge.length !== 1) {
    throw new SchemaError(PROVIDER, 'Sentral Cargo returned no unique tracking result');
  }
  if (heading.text().trim().toUpperCase() !== number) throw new IndeterminateError(PROVIDER, 'Sentral Cargo returned another receipt');
  const summary = clean(badge.text(), 120);
  if (!summary) throw new SchemaError(PROVIDER, 'Sentral Cargo returned no status for the receipt');

  const timeline = result.find('[data-timeline]');
  const rows = timeline.children('[data-event]').toArray();
  if (timeline.length > 1 || rows.length > 500) throw new SchemaError(PROVIDER, 'Sentral Cargo returned an invalid timeline');
  const events: Scan[] = rows.map(node => {
    const row = $(node);
    const details = row.children('div').children('p');
    const description = clean(details.first().text(), 450);
    const wording = clean(details.eq(1).text(), 120).toLowerCase();
    const clock = explicitOffsetTime(row.children('time').attr('datetime'));
    if (details.length !== 2 || !description || !wording || !clock) {
      throw new SchemaError(PROVIDER, 'Sentral Cargo returned an incomplete scan');
    }
    const stage = STATUS_PREFIXES.find(([pattern]) => pattern.test(description))?.[1] ?? BADGES.get(wording);
    const location = clean(DEPOT.exec(description)?.[1], 140);
    return { time: clock.iso, description, ...(location ? { location } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  events.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const newest = events[0];
  const stage = newest?.stage ?? BADGES.get(summary.toLowerCase());
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: newest?.description ?? summary,
    last_update: newest?.time ?? null,
    ...(events.length ? {} : { summary_only: true }),
    events,
  };
}

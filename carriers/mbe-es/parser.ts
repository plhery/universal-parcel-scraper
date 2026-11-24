import { load } from 'cheerio';
import { ChallengeError, IndeterminateError, InvalidInputError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { mbeEsStage } from './status.js';

export const PROVIDER = 'mbe-es';
// The page carries the whole site's menus and forms: about 860 kB.
export const MBE_ES_MAX_BYTES = 2_000_000;
/** The sentence the tracker gives a code it holds no shipment under. */
export const NOT_FOUND_NOTICE = 'La búsqueda del código de envío no ha dado ningún resultado';
// Akamai's refusal, which the site gives any client it takes for a robot, its interstitial checks and Cloudflare's.
// The real page carries reCAPTCHA in its contact forms, so that is no check.
export const MBE_ES_CHALLENGE = /<title>\s*(?:Access Denied|Just a moment|Attention Required)|errors\.edgesuite\.net|sec-if-cpt|bm-verify|_cf_chl/i;

// "ES0061-0L-000000VTHP": ES, the MBE Center's four digits, two letters or digits, then ten.
// The tracker finds a code only with its two hyphens.
const CODE = /^ES(\d{4})-?([0-9A-Z]{2})-?([0-9A-Z]{10})$/;
// "2026-11-13 10:45": a scan's wall clock, without a zone.
const CLOCK = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
// "Coslada - Ha llegado a las instalaciones": the courier's place, then its wording.
const AT_PLACE = /^([^-;.]{2,60}?) - (.+)$/;
// "(UPS) ES0061-0L-000000VTHP": the courier in brackets, then the code.
const SHIPMENT = /^(?:\(([^)]{1,40})\)\s*)?(\S+)$/;
const MAX_SCANS = 300;

/** An MBE Spain shipment code, written with its two hyphens as the tracker needs it. */
export function normalizeMbeEsNumber(raw: string): string {
  const parts = typeof raw === 'string' && raw.length <= 64 ? CODE.exec(raw.toUpperCase().replace(/\s+/g, '')) : null;
  if (!parts) throw new InvalidInputError(PROVIDER, 'MBE Spain tracks a shipment by its code: ES, four digits, then two and ten letters or digits');
  return `ES${parts[1]}-${parts[2]}-${parts[3]}`;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function clockOf(value: string): string | undefined {
  const parts = CLOCK.exec(value);
  const date = parts ? calendarDay(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
  return parts && date ? `${date}T${parts[4]}:${parts[5]}:00` : undefined;
}

/**
 * The tracker's page for one code (`/es/tracking?c=<code>`). It shows the code with the courier
 * that carries the shipment, who signed for it, and the courier's scans newest first, each as its
 * place and its wording in the courier's Spanish. The signer stays behind; the scans keep their
 * wall clock, as the page gives no zone.
 */
export function parseMbeEs(html: string, raw: string): CarrierResult {
  const code = normalizeMbeEsNumber(raw);
  if (MBE_ES_CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'MBE Spain answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const answer = $('.tracking-res');
  if (clean($('h1').first().text()) !== 'Tracking' || answer.length !== 1) return invalid('MBE Spain returned a page without its tracking answer');
  if (clean(answer.text(), 2000).includes(NOT_FOUND_NOTICE)) throw new NotFoundError(PROVIDER, 'MBE Spain has no shipment under this code');

  const fields = new Map(answer.find('.titolo').toArray().map((title) => [clean($(title).text(), 80), clean($(title).next('.responce').text(), 200)]));
  const shipment = SHIPMENT.exec(fields.get('Código') ?? '');
  if (!shipment) return invalid('MBE Spain returned a shipment without its code');
  if (shipment[2]!.toUpperCase() !== code) throw new IndeterminateError(PROVIDER, 'MBE Spain answered for another shipment');

  const rows = answer.find('.stato-ordine tr').toArray().map((row) => $(row).children('td').toArray().map((cell) => clean($(cell).text(), 300)));
  const scans = rows.filter((cells) => cells[0] !== 'FECHA');
  if (scans.length > MAX_SCANS) return invalid('MBE Spain returned too many scans');
  const events = scans.map((cells): CarrierEvent & { local_time: string } => {
    if (cells.length !== 2 || !cells[1]) return invalid('MBE Spain returned an unreadable scan');
    const localTime = clockOf(cells[0]!) ?? invalid('MBE Spain returned an invalid scan time');
    const place = AT_PLACE.exec(cells[1]);
    const description = place ? place[2]! : cells[1];
    const stage = mbeEsStage(description);
    return { local_time: localTime, description, ...(place ? { location: place[1]!, original_description: cells[1] } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) };
  });
  if (events.length === 0) throw new NoHistoryError(PROVIDER, 'MBE Spain lists the shipment without its scans', { reason: 'listed' });

  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.description ?? null,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    events,
  };
}

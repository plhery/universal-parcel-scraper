import { load, type CheerioAPI } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus } from '../../core/status/index.js';
import { paddedDate } from '../../core/time/fields.js';
import { firstOccurrence } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { gelStage } from './status.js';

export const PROVIDER = 'GEL Express';
// The page is a few hundred kilobytes of WordPress around the result.
export const GEL_MAX_BYTES = 2 * 1024 * 1024;

const ZONE = 'Europe/Berlin';
const NUMBER = /^\d{10}$/;
// "21.05.2026 um 14:10 Uhr": the wall clock in Germany, to the minute.
const CLOCK = /^(\d{2})\.(\d{2})\.(\d{4}) um (\d{2}):(\d{2}) Uhr$/;
const NOT_FOUND = /Ihre Sendungsnummer konnte leider nicht gefunden werden/;
// Bot checks a firewall or CDN could put in place of the page.
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|_cf_chl_opt|cf-turnstile|g-recaptcha|hcaptcha/i;

/** The ten digits of a GEL Sendungsnummer; anything else is not one GEL issues. */
export function normalizeGelNumber(raw: string): string {
  const number = raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GEL Express shipment numbers are ten digits');
  return number;
}

/** The value beside a label in the page's result tables. */
function fieldOf($: CheerioAPI, label: string): string | undefined {
  const values = $('table.svf tr').toArray().flatMap((tr) => {
    const cells = $(tr).children('td');
    return cells.length === 2 && clean(cells.first().text(), 80) === label ? [clean(cells.last().text(), 300)] : [];
  });
  if (values.length > 1) throw new SchemaError(PROVIDER, `GEL Express returned ${label} twice`);
  return values[0];
}

/**
 * The page GEL's tracker at gel-express.de/de/sendungsverfolgung renders for
 * one Sendungsnummer without the recipient's postcode: the shipment, then its
 * current status and when it was set. The page's form and its heading must
 * hold the whole number asked; the not-found notice's form must too. Earlier
 * statuses, without their times, are only icons on the page's progress rail.
 */
export function parseGel(html: string, raw: string): CarrierResult {
  const number = normalizeGelNumber(raw);
  const $ = load(html);
  const asked = $('form#svv input#snr').attr('value')?.trim();
  if (!$('#tsnr').length) {
    if (NOT_FOUND.test(clean($('main, body').first().text(), 4000))) {
      if (asked !== number) throw new IndeterminateError(PROVIDER, 'GEL Express answered for another number');
      throw new NotFoundError(PROVIDER);
    }
    if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GEL Express answered with a browser check');
    throw new SchemaError(PROVIDER, 'GEL Express did not return its tracking page');
  }
  if ($('#tsnr').length > 1) throw new IndeterminateError(PROVIDER, 'GEL Express listed several shipments');
  if (clean($('#tsnr').text(), 64) !== number || asked !== number) {
    throw new IndeterminateError(PROVIDER, 'GEL Express answered for another shipment');
  }

  const wording = fieldOf($, 'Aktueller Status');
  const clock = fieldOf($, 'Status vom');
  if (!wording || !clock) throw new SchemaError(PROVIDER, 'GEL Express returned a shipment without its status');
  const match = CLOCK.exec(paddedDate(clock));
  const at = match ? firstOccurrence(DateTime.fromObject({ year: Number(match[3]), month: Number(match[2]), day: Number(match[1]),
    hour: Number(match[4]), minute: Number(match[5]) }, { zone: ZONE })) : null;
  if (!at?.isValid) throw new SchemaError(PROVIDER, 'GEL Express returned an invalid status time');
  const staged = gelStage(wording);
  const time = at.toISO({ suppressMilliseconds: true });
  const event: CarrierEvent = {
    time,
    description: wording,
    ...(staged ? { stage: staged.stage, stage_source: staged.source } : {}),
  };
  const stage = staged?.stage;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(staged ? { current_stage: staged.stage, current_stage_source: staged.source } : {}),
    last_status_text: wording,
    last_update: time,
    expected_delivery: null,
    ...(stage === 'delivered' ? { delivered_at: time } : {}),
    events: [event],
  };
}

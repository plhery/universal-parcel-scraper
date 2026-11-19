import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { zonedTime } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { goLogisticsStage } from './status.js';

export const PROVIDER = 'GO Logistics';
export const CARRIER = 'go-logistics-au';
export const TIMEZONE = 'Australia/Sydney';
// A page is about 5 kB, more with a signature image.
export const GO_LOGISTICS_MAX_BYTES = 512 * 1024;

// Coupon and consignment numbers: ten digits in the public example, letters allowed.
const NUMBER = /^(?=.*\d)[A-Z0-9]{6,20}$/;
// Bot checks and firewall refusals that could stand in for the page.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|<title>\s*(?:Just a moment|Attention Required!|Access Denied)|g-recaptcha|h-captcha|The requested URL was rejected|Request Rejected/i;
const MAX_EVENTS = 200;
// Who signed for a delivery, as its scan names them: "Signed by NAME - 2 pieces".
const SIGNED_BY = /\bSigned by\s+(.+?)(?:\s+-\s+\d+\s+pieces?)?$/i;

/** A number for GO Logistics' tracker: six to twenty letters and digits. */
export function normalizeGoLogisticsNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'GO Logistics numbers are six to twenty letters and digits');
  return number;
}

/** The scans as the page lists them, oldest first: a wording, a day and a time on Sydney's clock. */
function scansOf($: CheerioAPI): CarrierEvent[] {
  const rows = $('.NTtrackInfo .NTitemLine').toArray();
  if (rows.length > MAX_EVENTS) throw new SchemaError(PROVIDER, 'GO Logistics returned an invalid history');
  return rows.map((row): CarrierEvent => {
    const history = $(row).find('.NTitemHistory').first().clone();
    // A delivery names its signatory, which the wording keeps after its own
    // words, and shows the signature, which is not kept.
    const signed = clean(history.find('.NTsignedby').text(), 200);
    history.find('.NTsignedby, img, br').remove();
    const wording = clean(history.text(), 200);
    const description = [wording, signed].filter(Boolean).join(' ');
    const day = clean($(row).find('.NTitemDate').first().text(), 20);
    const clock = clean($(row).find('.NTitemTime').first().text(), 12);
    const time = day && clock ? zonedTime(`${day} ${clock}`, 'd MMM yyyy h:mm a', TIMEZONE, { locale: 'en' })?.iso : undefined;
    if (!wording || !time) throw new SchemaError(PROVIDER, 'GO Logistics returned an invalid scan');
    const stage = goLogisticsStage(wording);
    return { time, description, ...(stage ? { stage: stage.stage, stage_source: stage.source } : {}) };
  });
}

/**
 * The scans of the latest consignment under the number. A number used again
 * lists every consignment, oldest first: a new booking or collection after a
 * delivery opens the next one, even with rows such as an upload in between,
 * and the scans up to the delivery, its signatory with them, are left out.
 */
function latestConsignment(scans: CarrierEvent[]): CarrierEvent[] {
  let start = 0;
  let delivery: number | null = null;
  for (const [index, scan] of scans.entries()) {
    if (scan.stage === 'delivered') {
      delivery = index;
    } else if (delivery !== null && (scan.stage === 'registered' || scan.stage === 'accepted')) {
      start = delivery + 1;
      delivery = null;
    }
  }
  return scans.slice(start);
}

/**
 * The tracker's page `services.gologistics.com.au/track/iframe2.php?item={number}`.
 * It repeats the number asked as its heading, then lists the consignment's
 * scans, oldest first, each with a day, a time on Sydney's clock, the driver's
 * number and a wording; a delivery adds the signatory and the signature. A
 * number it holds no scan for has the heading alone. The wording, the clock and
 * the signatory are kept.
 */
export function parseGoLogistics(html: string, raw: string): CarrierResult {
  const number = normalizeGoLogisticsNumber(raw);
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'GO Logistics answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  const info = $('.NTtrackInfo');
  if (info.length !== 1) throw new SchemaError(PROVIDER, 'GO Logistics returned an unexpected page');
  const shown = clean(info.find('.NTtrackItemHeading').first().text(), 64);
  if (!shown) throw new SchemaError(PROVIDER, 'GO Logistics returned a page without the number asked');
  if (normalizeTrackingNumber(shown) !== number) throw new IndeterminateError(PROVIDER, 'GO Logistics answered for another number');

  const events = latestConsignment(scansOf($))
    .sort((left, right) => Date.parse(left.time!) - Date.parse(right.time!))
    .reverse();
  const newest = events[0];
  if (!newest) throw new NotFoundError(PROVIDER, 'GO Logistics holds no scan for this number');
  const current = events.find((event) => event.stage);
  const stage = current?.stage as Stage | undefined;
  const signer = stage === 'delivered' ? SIGNED_BY.exec(current!.description!)?.[1] : undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: current!.stage_source! } : {}),
    last_status_text: newest.description!,
    last_update: newest.time!,
    expected_delivery: null,
    ...(signer ? { signed_by: signer } : {}),
    timezone: TIMEZONE,
    events,
  };
}

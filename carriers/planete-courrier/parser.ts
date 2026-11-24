import { load, type CheerioAPI } from 'cheerio';
import { normalizeTrackingNumber } from '../../core/detection/index.js';
import { ChallengeError, IndeterminateError, InvalidInputError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import type { CarrierEvent, CarrierResult } from '../../core/result/index.js';
import { languageStageStatus, type Stage } from '../../core/status/index.js';
import { calendarDay } from '../../core/time/index.js';
import { clean } from '../../core/transport/index.js';
import { planeteCourrierStage } from './status.js';

export const PROVIDER = 'planete-courrier';
// A page is about 40 kB; an order handed to a partner lists the partner's scans too.
export const PLANETE_COURRIER_MAX_BYTES = 512 * 1024;
/** The sentence the tracker's list gives a number it holds no order under. */
export const NOT_FOUND_NOTICE = 'aucune commande de placée chez Planète Courrier avec ce numéro de suivi';

// The tracker numbers its orders in sequence: seven digits in 2023, eight since.
const NUMBER = /^\d{6,10}$/;
const CHALLENGE = /<title>\s*(?:Just a moment|Attention Required|Access Denied)|cf-chl-|cf-turnstile|g-recaptcha|hcaptcha/i;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// "2 mai 2023" and "09:52": the scan's wall clock, without a zone.
const DAY = /^(\d{1,2})(?:er)? (\p{L}+),? (\d{4})$/u;
const HOUR = /^([01]?\d|2[0-3]):([0-5]\d)$/;
// "N° 9381042 via Fedex 608940108801": the order, and the partner it was handed to with the partner's number.
const TITLE = /^N° (\d+) via (.+)$/;
const PARTNER = /^(.+?)\s+([A-Z0-9]{8,40})$/;
// "Arrivé au centre de tri - Lachine, QC": a step at a depot names its town and province after a dash.
const AT_PLACE = /^(.+?) - ([^-]+, [A-Z]{2})$/;
const MAX_SCANS = 200;
/** The partners whose name the tracker gives an order handed over, by their catalog id. */
const PARTNERS: ReadonlyMap<string, string> = new Map([['fedex', 'fedex']]);

/** A Planète Courrier tracking number: the order number on the waybill. */
export function normalizePlaneteCourrierNumber(raw: string): string {
  const number = typeof raw === 'string' && raw.length <= 64 ? normalizeTrackingNumber(raw) : '';
  if (!NUMBER.test(number)) throw new InvalidInputError(PROVIDER, 'Planète Courrier tracks an order by its number of 6 to 10 digits');
  return number;
}

const invalid = (message: string): never => { throw new SchemaError(PROVIDER, message); };

function page(html: string): CheerioAPI {
  if (CHALLENGE.test(html.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'Planète Courrier answered with a browser check');
  const $ = load(html);
  $('script, style, noscript').remove();
  return $;
}

/** A span's text without the label the page shows on a phone ("Date : "). */
const cell = ($: CheerioAPI, span: Parameters<CheerioAPI>[0]) => {
  const copy = $(span).clone();
  copy.find('.libelleMobile').remove();
  return clean(copy.text(), 200);
};

function clockOf(day: string, hour: string): string | undefined {
  const date = DAY.exec(day);
  const time = HOUR.exec(hour);
  const month = date ? MONTHS.indexOf(date[2]!.toLocaleLowerCase('fr')) + 1 : 0;
  const iso = date && month ? calendarDay(Number(date[3]), month, Number(date[1])) : null;
  if (!iso || !time || Number(date![3]) < 2000) return undefined;
  return `${iso}T${time[1]!.padStart(2, '0')}:${time[2]}:00`;
}

/** The scans of the order's history, newest first. A row the page dates "Inconnu" is no scan. */
function scansOf($: CheerioAPI): (CarrierEvent & { local_time: string })[] {
  const heading = $('p.titrePrincipal').filter((_index, element) => clean($(element).text()) === 'Historique de commande');
  if (heading.length !== 1) return invalid('Planète Courrier returned an order without its history');
  const rows = heading.parent().find('ul > li').not('.enteteTableau').toArray();
  if (rows.length > MAX_SCANS) return invalid('Planète Courrier returned too many scans');
  return rows.flatMap((row) => {
    const spans = $(row).children('span').toArray().map((span) => cell($, span));
    if (spans.length !== 4 || !spans[3]) return invalid('Planète Courrier returned an unreadable scan');
    const [day, , hour, wording] = spans as [string, string, string, string];
    if (day === 'Inconnu') return [];
    const localTime = clockOf(day, hour) ?? invalid('Planète Courrier returned an invalid scan time');
    const place = AT_PLACE.exec(wording);
    const description = place ? place[1]! : wording;
    const stage = planeteCourrierStage(description);
    return [{ local_time: localTime, description, ...(place ? { location: place[2]!, original_description: wording } : {}),
      ...(stage ? { stage, stage_source: 'carrier_map' } : {}) }];
  }).reverse().sort((a, b) => b.local_time.localeCompare(a.local_time));
}

/**
 * The order's page (`detail=true`): its number and the carrier that delivers it, its destination
 * province and country, and its history, oldest first. A number the tracker holds no order under
 * gets the same page with its one step dated "Inconnu", and no scan is read from it: undefined
 * then, for the list to say whether the order exists. The page leaves the scans' zone out; the
 * recipient's address and the signature stay behind a postcode check.
 */
export function parsePlaneteCourrierDetail(html: string, raw: string): CarrierResult | undefined {
  const number = normalizePlaneteCourrierNumber(raw);
  const $ = page(html);
  const title = TITLE.exec(clean($('.informationReperage .secCol1 p.titrePrincipal').first().text(), 200));
  if (!title) return invalid('Planète Courrier returned a page without its order');
  if (title[1] !== number) throw new IndeterminateError(PROVIDER, 'Planète Courrier answered for another order');
  const events = scansOf($);
  if (events.length === 0) return undefined;

  const partner = title[2] === 'Planète Courrier' ? undefined : PARTNER.exec(title[2]!);
  const carrier = partner ? PARTNERS.get(partner[1]!.toLocaleLowerCase('en')) : undefined;
  const destination = clean($('.divDestinationPetit').first().text(), 40);
  const staged = events.find((event) => event.stage);
  const stage = staged?.stage as Stage | undefined;
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: events[0]!.original_description ?? events[0]!.description ?? null,
    last_update: null,
    last_update_local: events[0]!.local_time,
    expected_delivery: null,
    ...(/, CAN$/.test(destination) ? { destination_country: 'CA' } : {}),
    ...(carrier && partner ? { delivery_carrier: carrier, delivery_tracking_number: partner[2]! } : {}),
    events,
  };
}

/**
 * The tracker's list of the orders a number names. A number it holds no order under gets its
 * notice; an order old enough to be "Commande expirée" gets the same notice, while its page can
 * still show its history. Returns the status the list gives the order asked for.
 */
export function parsePlaneteCourrierList(html: string, raw: string): CarrierResult {
  const number = normalizePlaneteCourrierNumber(raw);
  const $ = page(html);
  const block = $('.informationReperage').filter((_index, element) => clean($(element).find('p.titrePrincipal').first().text()) === 'Livraisons liées à ce numéro');
  if (block.length !== 1) return invalid('Planète Courrier returned a page without its list of orders');
  if (clean(block.find('.messageErreur').text()).includes(NOT_FOUND_NOTICE)) {
    throw new NotFoundError(PROVIDER, 'Planète Courrier has no order under this number');
  }
  const rows = block.find('li.videotronCtn').toArray().map((row) => {
    const spans = $(row).children('span').toArray();
    return { number: clean($(spans[0]).text(), 20), status: clean($(row).find('.statInfoWrapper h4').first().text(), 80) };
  });
  if (rows.length === 0) return invalid('Planète Courrier returned an empty list of orders');
  const row = rows.find((candidate) => candidate.number === number);
  if (!row) throw new IndeterminateError(PROVIDER, 'Planète Courrier listed other orders under this number');
  const stage = planeteCourrierStage(row.status);
  return {
    status: stage ? languageStageStatus(stage) : 'unknown',
    ...(stage ? { current_stage: stage, current_stage_source: 'carrier_map' } : {}),
    last_status_text: row.status || null,
    last_update: null,
    expected_delivery: null,
    summary_only: true,
    events: [],
  };
}

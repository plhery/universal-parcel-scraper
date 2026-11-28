import { clean } from '../../core/transport/text.js';

// Four to six digits standing alone in scan text are a postcode far more often than anything else,
// except a date's year, as in "2026-10-24", "24/10/2026" or "March 10, 2026".
const POSTCODE_RUN = /(^|[^\p{L}\p{N}])(?<!\d{1,2}[-/.]\d{1,2}[-/.]|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? \d{1,2},? ?)(?!\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d))\d{4,6}(?![\p{L}\p{N}])/giu;
// The postcodes written otherwise in a delivery row's place: three and two digits (Greece, Czechia,
// Slovakia, Sweden), two and three or four and three with a dash (Poland, Portugal), letters and digits
// (Canada, the United Kingdom) and four digits and two letters (the Netherlands).
const POSTCODE_FORM = /(^|[^\p{L}\p{N}])(?:\d{3} \d{2}|\d{2}-\d{3}|\d{4}-\d{3}|[A-Z]\d[A-Z] ?\d[A-Z]\d|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}|\d{4} ?[A-Z]{2})(?![\p{L}\p{N}])/gu;
// A country's letters before a postcode, as in "CH-8001", "NL-1012 AB" or "SK-811 01", go with it.
const POSTCODE_COUNTRY = /(^|[^\p{L}\p{N}])[A-Z]{1,2}-(?=(?:\d{3} \d{2}|\d{2}-\d{3}|\d{4}-\d{3}|\d{4} ?[A-Z]{2}|\d{4,6})(?![\p{L}\p{N}]))/gu;
// Brackets a postcode leaves empty.
const EMPTY_BRACKETS = /\(\s*\)|（\s*）/g;
// A signatory's name follows these markers.
const SIGNATORY = /(?:签收人|signed (?:for )?by|signatory)[\s\S]*$/i;

// The interface replies in GBK, which has no room for some spaces: one between two words, or between a
// month and its day ("November?4"), arrives as `?`.
const LOST_SPACE = /(?<=[\p{L}\p{N}])\?(?=[\p{L}\p{N}])/gu;
// GBK has no ô, ç or î either, so a French row the tracker copies from the destination's post loses them to `?` too,
// as Colissimo's "Votre Colissimo va bient?t nous être confié !". In the words those rows use the letter comes back.
const LOST_LETTERS: readonly (readonly [RegExp, string])[] = [
  [/(?<=\bbient)\?(?=t\b)/gi, 'ô'], [/(?<=\b(?:entre|dé|de)p)\?(?=ts?\b)/gi, 'ô'],
  [/(?<=\bre)\?(?=u(?:e|s|es)?\b)/gi, 'ç'], [/(?<=\bbo)\?(?=tes?\b)/gi, 'î'],
];
const restoreLetters = (value: string): string => LOST_LETTERS.reduce((text, [lost, letter]) => text.replace(lost, letter), value);

// A partner's row can come with its markup, escaped or not: DHL's "more information<a href=…> here.</a>".
const MARKUP = /<\/?[a-z][^<>]*>|&lt;\/?[a-z][\s\S]*?&gt;/gi;
const ENTITIES: Readonly<Record<string, string>> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const ENTITY = /&(?:amp|quot|#39|apos|nbsp);/g;

/** How a tenant's scan text is read. */
export interface HualeiTextOptions {
  /**
   * The tenant copies rows in a language whose letters GBK cannot hold, as Posti's Finnish ä and ö:
   * a question mark between two letters is then such a letter, kept as the track interface gives
   * it, not a space GBK lost.
   */
  readonly lostLetters?: true;
}

/** Scan text without markup, a signatory or a postcode. */
export function hualeiScanText(value: string, maxLength = 500, options: HualeiTextOptions = {}): string {
  const text = restoreLetters(value.replace(MARKUP, ' ').replace(ENTITY, (entity) => ENTITIES[entity]!));
  return clean((options.lostLetters ? text : text.replace(LOST_SPACE, ' ')).replace(SIGNATORY, '').replace(POSTCODE_COUNTRY, '$1').replace(POSTCODE_FORM, '$1')
    .replace(POSTCODE_RUN, '$1').replace(EMPTY_BRACKETS, ''), maxLength)
    .replace(/^[\s,，:：;；/]+|[\s,，:：;；/]+$/g, '');
}

// What some trackers print in a row's place when it has none: the platform's "SYSTEM", alone or after a
// country's code as a relayed label row gives it ("US, SYSTEM, SYSTEM"), a form's "Delivery Location", and
// "海关", Chinese for customs, on a customs row.
const NO_PLACE = /^(?:(?:[A-Z]{2}, ?)?system(?:, ?system)*|delivery location|海关)$/i;

/** A row's place as scan text, or nothing where the tracker prints a word for no place. */
export function hualeiPlace(value: string, options: HualeiTextOptions = {}): string {
  const place = hualeiScanText(value, 200, options);
  return NO_PLACE.test(place) ? '' : place;
}

/**
 * A row's wording as scan text, without its place where the tracker writes that place again at the
 * head of the wording: "US, SYSTEM, SYSTEM, Shipping Label Created" at "US, SYSTEM, SYSTEM".
 */
export function hualeiWording(content: string, location: string, options: HualeiTextOptions = {}): string {
  const wording = hualeiScanText(content, 500, options);
  const place = hualeiScanText(location, 200, options);
  if (!place || wording.slice(0, place.length).toLowerCase() !== place.toLowerCase()) return wording;
  const rest = /^\s*[,，]\s*(\S[\s\S]*)$/.exec(wording.slice(place.length));
  return rest ? rest[1]! : wording;
}

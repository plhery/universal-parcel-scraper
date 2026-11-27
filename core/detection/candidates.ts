/**
 * Candidate numbers inside free text.
 *
 * What it is: the two scans over a whole shipping message, or a URL with no
 * matching link rule, for the shapes in candidatePatterns.ts.
 * What it is not: no carrier decision of its own (it defers to the detection
 * engine) and no provider I/O.
 */
import { calendarDay } from '../time/index.js';
import { brandCarrierIds, carrierIdFromName, isKnownCarrierName } from '../catalog/hints.js';
import { TRACKING_CANDIDATE_PATTERNS } from './candidatePatterns.js';
import { detectCarrierMatch } from './detect.js';
import { validTrackingNumberInText } from './valid.js';

/**
 * The most distinct candidates one reading of a text asks the detection
 * engine about. A shipping email or an order page offers a few hundred, and
 * the 16 KB a caller accepts, written as dense prose, about seven hundred; a
 * paste of thousands of distinct numbers would otherwise hold the thread for
 * a second. The first ones met are asked, in the order the scans meet them.
 */
export const MOST_TEXT_CANDIDATES = 1500;

/**
 * The candidates one reading has asked about. Detection reads a candidate in
 * capitals, so a spelling in other letter cases needs no second answer, and
 * one that no carrier claimed confidently is skipped by every later scan.
 */
export interface CandidateScan { readonly asked: Set<string> }

export function candidateScan(): CandidateScan {
  return { asked: new Set() };
}

/**
 * The first candidate in the text that one carrier claims confidently, among
 * those `scan` has not asked about yet. A candidate holds a digit: some
 * carriers' shapes also fit a word, "additional" for one, and a word of a
 * message or a link is no number. A number typed alone is read whole, digits
 * or not.
 */
export function recognizedNumberInScan(raw: string, scan: CandidateScan): string | undefined {
  for (const pattern of TRACKING_CANDIDATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      const candidate = match[0].trim();
      if (!/\d/.test(candidate) && candidate !== raw.trim()) continue;
      // A tax number is skipped where its label stands, not asked about: the same number printed elsewhere is read there.
      if (followsTaxLabel(raw, match.index + match[0].indexOf(candidate))) continue;
      const key = candidate.toUpperCase();
      if (scan.asked.has(key)) continue;
      if (scan.asked.size >= MOST_TEXT_CANDIDATES) return undefined;
      scan.asked.add(key);
      if (detectCarrierMatch(candidate).confidence === 'high') return candidate;
    }
  }
  return undefined;
}

// A tax or company number's label: "BTW: BE0123456789", "VAT No.", "USt-IdNr.:", "NIP", "DIČ", "IČ DPH", "CUI". Belgium's,
// Poland's and Slovakia's VAT numbers and some of Czechia's and Romania's are a country's code and ten digits, the shape
// of Amazon's tracking numbers, and a business prints its own in the signature of every email it sends.
const TAX_WORDS = String.raw`vat|btw|tva|ust|mwst|uid|nip|di[cč]|i[cč]\s*dph|cui|cif|nif|iva|moms|mva|alv|[aá]fa|pvm|pvn|ddv|oib|kmkr|tax|tin`;
const TAX_QUALIFIERS = String.raw`id|idnr|nr|no|n[°º]|number|nummer|num[eé]ro|n[uú]mero|reg|registration|intracom(?:munautaire)?|code`;
const TAX_LABEL = new RegExp(
  String.raw`(?<![\p{L}0-9])(?:${TAX_WORDS})(?:[\s.\-/]*(?:${TAX_QUALIFIERS})(?!\p{L}))*[\s.]*[:#]?\s*$`,
  'iu',
);

/**
 * Whether the number starting at `index` of a text follows a tax or company number's label on its line, as a
 * business's VAT number does in its signature: "BTW: BE0123456789". Such a number is no tracking number, whatever
 * carrier its shape fits.
 */
export function followsTaxLabel(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return TAX_LABEL.test(text.slice(Math.max(lineStart, index - 48), index));
}

/** The first candidate in the text that one carrier claims confidently. */
export function recognizedNumberInText(raw: string): string | undefined {
  return recognizedNumberInScan(raw, candidateScan());
}

// The second word of a label. "No" and "ID" also start numbers, so they belong
// to the label only when they stand apart from what follows.
const LABEL_SUFFIX = String.raw`(?:numbers?(?!\p{L})|no\.|(?:no|id)(?![\p{L}0-9.]))`;
// Other languages name the parcel or its tracking, with a word for its number
// before or after: "numéro de suivi", "Sendung Nr.", "número de envío", "numer
// przesyłki", "numéro d'expédition", or join the two: "Sendungsnummer", "zendingnummer".
// A courier's label names its waybill: "Waybill No.", "AWB", "número de guía". A
// customer service line is no label: "Service colis : 01 23 45 67 89".
const PARCEL_WORDS = String.raw`suivi|colis|envoi|exp[eé]dition|sendung|paket|pakket|zending|seguimiento|rastreo|env[ií]o|paquete|gu[ií]a`
  + String.raw`|tracciamento|spedizione|pacco|rastreio|rastreamento|encomenda|przesy[lł]k[ai]|paczk[ai]`;
const NUMBER_WORDS = String.raw`num[eé]ro|n[uú]mero|numer|nummer|nr\.?|n\.?\s?[°º]`;
// A carrier's name can stand between a label and its number, before the word for the number
// or the separator: "N° de suivi DPD :", "Votre colis DPD n°", "Sendungsnummer DHL:". Up to
// three words of letters, read as few as the label needs; `keywordNumberInText` keeps only
// a name the catalog knows.
const NAME_WORD = String.raw`\p{L}[\p{L}'’&-]{0,19}`;
const CARRIER_NAME = String.raw`(?:\s+(?<carrier>${NAME_WORD}(?:\s+${NAME_WORD}){0,2}?)(?:\s*(?:${NUMBER_WORDS}))?)??`;
// Russian: "трек-номер", "номер отправления", "почтовый идентификатор", "ШПИ".
const RUSSIAN_LABEL = String.raw`(?<!\p{L})(?:трек(?:инг)?[-\s]?(?:номер|код)[а-яё]{0,3}`
  + String.raw`|номер[а-яё]{0,2}\s+(?:для\s+)?(?:отслеживания|отправления|посылки|почтового\s+отправления)`
  + String.raw`|почтов(?:ый|ого|ым)\s+идентификатор[а-яё]{0,2}|шпи)(?!\p{L})`;
// Chinese has no space between words, so its label needs none before or after: the
// number must still start with a Latin letter or a digit. Never a bare "单号", which
// ends "订单号", an order number.
const CHINESE_LABEL = String.raw`(?:(?:运|運|快递|快遞|物流|包裹)(?:单|單)(?:号|號|编号|編號)|(?:运|運)(?:单|單)`
  + String.raw`|(?:追踪|追蹤|跟踪|跟蹤)(?:单号|單號|号码|號碼|编号|編號|号|號|码|碼))(?:\s*(?:是|为|為))?`;
const LABELLED_NUMBER = new RegExp(
  String.raw`(?:track(?:ing)?(?:\s*${LABEL_SUFFIX}|(?!\p{L}))`
  + String.raw`|(?:parcel|package|shipment|waybill|awb)(?:\s+(?:tracking(?!\p{L})|${LABEL_SUFFIX})|(?!\p{L}))`
  + String.raw`|(?<!service\s{1,3})(?:(?:${NUMBER_WORDS})\s*(?:(?:de|du|di|del|do|da)\s+|d')?)?(?:${PARCEL_WORDS})(?!\p{L})(?:\s*(?:${NUMBER_WORDS}))?`
  + String.raw`|${RUSSIAN_LABEL}|${CHINESE_LABEL}`
  // A joined word is read from its start: a later start in the same word reads no more, and would try every letter.
  + String.raw`|(?<!\p{L})\p{L}*(?:sendungs|paket|tracking|zending)nummer)`
  + CARRIER_NAME
  // An email's template can print its separator twice: "Tracking Number: : 1234567899". Chinese and
  // Japanese text print a full-width colon.
  + String.raw`(?:\s+(?:is|est|es|ist|lautet|è|é|jest)(?:\s+(?:le|el|il|o))?(?![\p{L}0-9]))?\s*(?:[:：#-]\s*){0,2}`
  // The token holds a digit, so a label followed by a plain word does not end the search. Groups
  // printed apart may follow it: "1Z 999 AA1 01 2345 6784".
  + String.raw`(?<number>(?=[A-Z0-9.-]{0,39}\d)(?:[A-Z0-9][A-Z0-9.-]{3,39}|[A-Z0-9][A-Z0-9.-]{1,2}(?=\s[A-Z0-9]*\d))`
  + String.raw`(?:\s[A-Z0-9]{2,6}(?![\p{L}0-9]))*)`,
  'giu',
);
// A word that offers a second number: "tracking 1234567899 or 9987654321".
export const ALTERNATIVE_WORDS = 'or|oder|ou|o|of|lub';
const ALTERNATIVE_NUMBER = new RegExp(String.raw`^\s+(?:${ALTERNATIVE_WORDS})\s+[A-Z0-9.-]*\d`, 'i');
// A date, day or year first: "12.11.2026", "2026-11-12".
const DATE = /^(?:\d{1,2}([./-])\d{1,2}\1\d{2,4}|\d{4}([./-])\d{1,2}\2\d{1,2})$/;
// A year that a month and day follow, which Chinese and Japanese text prints with no space
// after it: "2026/11/12发货". A year marked 年 is a year whatever follows it: "2026年11月".
const YEAR_OF_DATE = /^\d{4}([./-])\d{1,2}\1\d{1,2}(?!\d)/;
const MARKED_YEAR = /^\d{4}\s*年/;
// A phone number in the French and Belgian layout: a 0, then two-digit groups printed apart.
const PHONE = /^0\d(?:[ .-]\d{2}){4}$/;

/** Whether a labelled token is a date, written whole or ending a sentence. */
export function isDateToken(token: string): boolean {
  const value = token.replace(/[.,;:]+$/, '');
  if (!DATE.test(value)) return false;
  const [first, middle, last] = value.split(/[./-]/);
  const yearFirst = first!.length === 4;
  const year = Number(yearFirst ? first : last);
  const day = Number(yearFirst ? last : first);
  return calendarDay(year, Number(middle), day) !== null
    || (!yearFirst && calendarDay(year, day, Number(middle)) !== null);
}

/**
 * Last resort: a number introduced by a "tracking number:" style label. A
 * label that offers two numbers names neither, and a date is no number, though
 * a later label may still introduce one. A number printed in groups is read
 * whole when a carrier claims it or when its groups are short and make eight
 * characters or more: "0034 0434 1234 5678". A text with no such label can
 * still use a carrier's name as one, for a number in that carrier's shape:
 * "DPD: 01234567890128".
 */
export function keywordNumberInText(raw: string): string | undefined {
  const labelled = labelledNumberInText(raw);
  return labelled === undefined ? namedNumberInText(raw) : labelled ?? undefined;
}

// The number a tracking label introduces; null when a label introduces none and decides the text holds none.
function labelledNumberInText(raw: string): string | null | undefined {
  const labels = new RegExp(LABELLED_NUMBER);
  for (let match = labels.exec(raw); match; match = labels.exec(raw)) {
    const { carrier, number } = match.groups!;
    // Words the catalog names no carrier by are the message's ("Suivi de votre colis :",
    // "Suivi Commande :"): the search goes on from the label's next character.
    if (carrier !== undefined && !isKnownCarrierName(carrier)) {
      labels.lastIndex = match.index + 1;
      continue;
    }
    // Each later group holds a digit, but for the two capitals that close an S10 code: "RR 123 456 789 FR".
    const [first, ...rest] = number!.split(/\s/);
    const groups = [first!];
    for (const group of rest) {
      const digits = /\d/.test(group);
      if (!digits && !/^[A-Z]{2}$/.test(group)) break;
      groups.push(group);
      if (!digits) break;
    }
    const start = match.index + match[0].length - number!.length;
    const end = start + groups.join(' ').length;
    if (ALTERNATIVE_NUMBER.test(raw.slice(end))) return null;
    // A sentence can end right after its number.
    const joins = groups.map((_, count) => groups.slice(0, count + 1).join('').replace(/[.-]+$/, ''));
    const claimed = joins.slice(1).reverse().find((joined) => detectCarrierMatch(joined).confidence === 'high');
    // A date printed in groups or with slashes, which end the token, or a year a month and day follow is no number either.
    const after = raw.slice(start);
    const datePrefix = YEAR_OF_DATE.exec(after)?.[0] ?? '';
    if (!claimed && (isDateToken(groups.join('.')) || isDateToken(/^\S*/.exec(after)![0]) || isDateToken(datePrefix)
      || MARKED_YEAR.test(after))) continue;
    // A phone number is no tracking number either, and a later label may still introduce one.
    if (!claimed && PHONE.test(groups.join(' ').replace(/[.-]+$/, ''))) continue;
    const grouped = groups.length > 1 && groups.every((group) => group.length <= 6) && joins.at(-1)!.length >= 8
      ? joins.at(-1) : undefined;
    const candidate = claimed ?? grouped ?? joins[0]!;
    if (candidate.length < 4 || isDateToken(candidate)) return null;
    return validTrackingNumberInText(candidate) ? candidate : null;
  }
  return undefined;
}

// A carrier's name standing as its number's label, before a colon or alone on the line above it: "DPD: 01234567890128",
// as a shop's order table prints its carrier's column. The number is one unbroken token, so a phone line printed in
// groups, "DPD : 0800 …", introduces none.
const NAMED_NUMBER = new RegExp(
  String.raw`(?:(?<![\p{L}0-9'’&-])(?<name>${NAME_WORD}(?:[ \t]+${NAME_WORD}){0,2}?)[ \t]*[:：]`
  + String.raw`|(?:^|\n)[ \t]*(?<alone>${NAME_WORD}(?:[ \t]+${NAME_WORD}){0,2})[ \t]*\r?\n(?:[ \t]*\r?\n)?)[ \t]*`
  + String.raw`(?<number>(?=[A-Z]*\d)[A-Z0-9]{8,40})(?![\p{L}0-9_-]|[./][\p{L}0-9])`,
  'giu',
);
// A national phone number written whole: a 0 and eight to ten more digits.
const WHOLE_PHONE = /^0\d{8,10}$/;

/**
 * A number after a carrier's name used as its label, read only when the number's shape fits a carrier the name
 * stands for: the name's own carrier, or one of its brand's networks for a brand such as DPD or GLS.
 */
function namedNumberInText(raw: string): string | undefined {
  const labels = new RegExp(NAMED_NUMBER);
  for (let match = labels.exec(raw); match; match = labels.exec(raw)) {
    const { name, alone, number } = match.groups!;
    labels.lastIndex = match.index + 1;
    const named = name ?? alone!;
    const own = carrierIdFromName(named);
    const carriers = own ? [own] : brandCarrierIds(named);
    if (carriers.length === 0 || WHOLE_PHONE.test(number!)) continue;
    const detected = detectCarrierMatch(number!, { inText: true });
    if (![detected.carrier, ...detected.candidates].some((carrier) => carriers.includes(carrier))) continue;
    if (ALTERNATIVE_NUMBER.test(raw.slice(match.index + match[0].length))) return undefined;
    return validTrackingNumberInText(number!) ? number : undefined;
  }
  return undefined;
}

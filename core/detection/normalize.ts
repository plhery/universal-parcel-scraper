import { postlogisticsIdentifier } from '../../carriers/postlogistics/number.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { CHECKSUMS } from './checksums.js';
import { restsOnCheckDigit, ruleFits } from './rules.js';
import { noLimitShipmentNumber } from './noLimit.js';
import { hasS10CheckDigit } from './s10CheckDigit.js';

/**
 * Tracking-number normalization and display formatting.
 *
 * What it is: the one place that decides what "the same number" means, plus
 * the printed grouping carriers use on their labels.
 * What it is not: no carrier lookup and no provider I/O. It reads check digits only to tell
 * a typed letter O from a zero in an S10 serial and a whole barcode from a number pasted twice.
 */

// A repeated block may itself be a whole barcode, as a USPS one whose halves repeat. A shape with
// its own prefix and a check digit that holds tells it from a number pasted twice; a length or a check
// digit alone does not, nor a shape whose check digit fails.
// A check that normalizes the number it is given (USPS's) reads it whole meanwhile.
let checking = false;
function hasCheckedShape(number: string): boolean {
  if (checking) return true;
  checking = true;
  try {
    return Object.values(CARRIER_DEFINITIONS).some(carrier => carrier.detectionRules.some(rule => rule.checksum !== undefined
      && !restsOnCheckDigit(rule) && ruleFits(rule, number, number) && CHECKSUMS[rule.checksum](number)));
  } finally {
    checking = false;
  }
}

/**
 * Uppercase and strip spaces, dots and dashes (Swiss Post prints 99.34.…).
 * A label prints its SSCC behind the bracketed GS1 identifier, "(00) 3 7012345
 * 678901234 7", and carriers track it as the twenty digits without brackets.
 * A label can also print a number's last digit in brackets, as PIN AG's FAQ
 * shows its registered letters, "000000000000(0)": the number reads without them.
 * Other bracketed identifiers stay as typed: (420), for one, carries a ZIP.
 * An S10 serial holds only digits, so a letter O in it ("CIO…NL") is a zero
 * typed as a letter when the check digit then holds. No carrier issues "JDO1"
 * and sixteen digits either: it is a DHL Express piece, JD01, with its zero
 * typed as a letter. Nor does any carrier issue "JRTO", ten digits and MM: it
 * is a JRT number with a letter O typed after its prefix, and JRT's tracker
 * knows it only without the O. A JS Express waybill, JSE, two letters, ten
 * digits and YQ, holds only digits between its letters, so a letter O there is
 * a zero typed as a letter: the tracker knows the number with the zero. A zero
 * typed for its second letter, which leaves eleven digits, is the letter O: the
 * tracker knows the number with the letter. WanbExpress's WNB waybills, two
 * letters, ten digits and YQ, hold only digits between their letters too, and
 * their public numbers' digits open with a zero, so a letter O among them is a
 * zero typed as a letter. GOFO's GFUS and GFCA waybills go on
 * with a zero, so a letter O there is that zero: no carrier issues GFUS or GFCA,
 * a letter O and thirteen digits, and GOFO's tracker knows the number with the
 * zero. Allegro One's AD0 numbers hold no vowel after AD0, so a letter O in one
 * is a zero typed as a letter. SPX Brazil's BR numbers hold twelve digits
 * before their last character, so a letter O among them is a zero typed as a
 * letter: no carrier issues such a number, and SPX's tracker knows it with the
 * zero. A NO
 * LIMIT shipment number, P/1234/LABC/2026, reads the same without its slashes,
 * which are dropped. MRW's receipts print a slash after the office's five
 * digits, 01234/A567890, and its tracker knows the twelve characters without it.
 * A number of ten characters or more pasted twice in a row reads once, unless it
 * repeats one character, which is no number.
 */
export function normalizeTrackingNumber(raw: string): string {
  const typed = raw.toUpperCase().replace(/[\s.-]/g, '');
  const twice = /^([A-Z0-9]{10,40})\1$/.exec(typed)?.[1];
  const value = twice && !/^(.)\1*$/.test(twice) && !hasCheckedShape(typed) ? twice : typed;
  if (/^\(00\)\d{18}$/.test(value)) return `00${value.slice(4)}`;
  const lastDigit = /^(\d{12,})\((\d)\)$/.exec(value);
  if (lastDigit) return `${lastDigit[1]}${lastDigit[2]}`;
  const shipment = value.includes('/') ? noLimitShipmentNumber(value) : undefined;
  if (shipment) return shipment;
  const mrw = /^(\d{5})\/(\d{7}|[A-Z]\d{6})$/.exec(value);
  if (mrw) return `${mrw[1]}${mrw[2]}`;
  const piece = /^(J?JD)O(1\d{16}J?)$/.exec(value);
  if (piece) return `${piece[1]}0${piece[2]}`;
  const jrt = /^JRTO(\d{10}MM)$/.exec(value);
  if (jrt) return `JRT${jrt[1]}`;
  const gofo = /^(GF(?:US|CA))O(\d{13})$/.exec(value);
  if (gofo) return `${gofo[1]}0${gofo[2]}`;
  const allegro = /^AD[0O][0-9B-DF-HJ-NP-TV-XZO]{14}$/.test(value) ? value.slice(2) : '';
  if (allegro.includes('O')) return `AD${allegro.replace(/O/g, '0')}`;
  const jsExpress = /^(JSE[A-Z])([A-Z0])([\dO]{10})YQ$/.exec(value);
  if (jsExpress && (jsExpress[2] === '0' || jsExpress[3]!.includes('O'))) {
    return `${jsExpress[1]}${jsExpress[2] === '0' ? 'O' : jsExpress[2]}${jsExpress[3]!.replace(/O/g, '0')}YQ`;
  }
  const wanb = /^(WNB[A-Z]{2})([\dO]{10})YQ$/.exec(value);
  if (wanb?.[2]!.includes('O')) return `${wanb[1]}${wanb[2]!.replace(/O/g, '0')}YQ`;
  const spxBrazil = /^BR([\dO]{12})([0-9A-Z])$/.exec(value);
  if (spxBrazil?.[1]!.includes('O')) return `BR${spxBrazil[1]!.replace(/O/g, '0')}${spxBrazil[2]}`;
  const serial = /^([A-Z]{2})([\dO]{9})([A-Z]{2})$/.exec(value);
  if (!serial?.[2]!.includes('O')) return value;
  const digits = serial[2]!.replace(/O/g, '0');
  return hasS10CheckDigit(digits) ? `${serial[1]}${digits}${serial[3]}` : value;
}

/** Capability-link shipment numbers look like 999.90.########. */
export function isPlanzerSharedTrackingNumber(raw: string): boolean {
  return /^99990\d{8}$/.test(normalizeTrackingNumber(raw));
}

/** Swiss carriers show 18-digit barcodes as 99.34.123456.12345678. */
export function formatTrackingNumber(raw: string, carrier?: string): string {
  if (carrier === 'postlogistics') return postlogisticsIdentifier(raw);
  const value = normalizeTrackingNumber(raw);
  if (isPlanzerSharedTrackingNumber(value)) {
    return `${value.slice(0, 3)}.${value.slice(3, 5)}.${value.slice(5)}`;
  }
  if (/^\d{18}$/.test(value)) {
    return `${value.slice(0, 2)}.${value.slice(2, 4)}.${value.slice(4, 10)}.${value.slice(10)}`;
  }
  return value;
}

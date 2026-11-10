import { postlogisticsIdentifier } from '../../carriers/postlogistics/number.js';
import { noLimitShipmentNumber } from './noLimit.js';
import { hasS10CheckDigit } from './s10CheckDigit.js';

/**
 * Tracking-number normalization and display formatting.
 *
 * What it is: the one place that decides what "the same number" means, plus
 * the printed grouping carriers use on their labels.
 * What it is not: no carrier lookup and no provider I/O. The only check digit
 * it reads is an S10 serial's, to tell a typed letter O from a zero.
 */

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
 * tracker knows the number with the letter. GOFO's GFUS and GFCA waybills go on
 * with a zero, so a letter O there is that zero: no carrier issues GFUS or GFCA,
 * a letter O and thirteen digits, and GOFO's tracker knows the number with the
 * zero. A NO
 * LIMIT shipment number, P/1234/LABC/2026, reads the same without its slashes,
 * which are dropped.
 */
export function normalizeTrackingNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  if (/^\(00\)\d{18}$/.test(value)) return `00${value.slice(4)}`;
  const lastDigit = /^(\d{12,})\((\d)\)$/.exec(value);
  if (lastDigit) return `${lastDigit[1]}${lastDigit[2]}`;
  const shipment = value.includes('/') ? noLimitShipmentNumber(value) : undefined;
  if (shipment) return shipment;
  const piece = /^(J?JD)O(1\d{16}J?)$/.exec(value);
  if (piece) return `${piece[1]}0${piece[2]}`;
  const jrt = /^JRTO(\d{10}MM)$/.exec(value);
  if (jrt) return `JRT${jrt[1]}`;
  const gofo = /^(GF(?:US|CA))O(\d{13})$/.exec(value);
  if (gofo) return `${gofo[1]}0${gofo[2]}`;
  const jsExpress = /^(JSE[A-Z])([A-Z0])([\dO]{10})YQ$/.exec(value);
  if (jsExpress && (jsExpress[2] === '0' || jsExpress[3]!.includes('O'))) {
    return `${jsExpress[1]}${jsExpress[2] === '0' ? 'O' : jsExpress[2]}${jsExpress[3]!.replace(/O/g, '0')}YQ`;
  }
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

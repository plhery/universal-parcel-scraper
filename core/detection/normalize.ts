import { postlogisticsIdentifier } from '../../carriers/postlogistics/number.js';

/**
 * Tracking-number normalization and display formatting.
 *
 * What it is: the one place that decides what "the same number" means, plus
 * the printed grouping carriers use on their labels.
 * What it is not: no carrier lookup, no checksum validation, no provider I/O.
 */

/**
 * Uppercase and strip spaces, dots and dashes (Swiss Post prints 99.34.…).
 * A label prints its SSCC behind the bracketed GS1 identifier, "(00) 3 7012345
 * 678901234 7", and carriers track it as the twenty digits without brackets.
 * Other bracketed identifiers stay as typed: (420), for one, carries a ZIP.
 */
export function normalizeTrackingNumber(raw: string): string {
  const value = raw.toUpperCase().replace(/[\s.-]/g, '');
  return /^\(00\)\d{18}$/.test(value) ? `00${value.slice(4)}` : value;
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

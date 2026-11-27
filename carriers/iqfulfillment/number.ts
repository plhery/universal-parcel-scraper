/**
 * A merchant's order reference as IQ Fulfillment's tracker finds it: letters and digits, with a
 * digit, and the hyphens some references carry before a suffix, as a reshipped order's `-1`. The
 * tracker finds such an order only with its hyphen: without it the digits name another order or
 * none.
 */
export const IQFULFILLMENT_REFERENCE = /^(?=[A-Z-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const IQFULFILLMENT_MIN_LENGTH = 5;
export const IQFULFILLMENT_MAX_LENGTH = 40;

/** A reference that holds a hyphen, uppercased, without spaces and with one hyphen between its parts, as the tracker takes it. */
export function iqfulfillmentReference(raw: string): string | undefined {
  const reference = raw.replace(/\s/g, '').toUpperCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
  return reference.includes('-') && reference.length >= IQFULFILLMENT_MIN_LENGTH && reference.length <= IQFULFILLMENT_MAX_LENGTH
    && IQFULFILLMENT_REFERENCE.test(reference) ? reference : undefined;
}

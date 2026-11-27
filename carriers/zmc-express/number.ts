/**
 * A ZMC Express reference as its tracker finds it: letters and digits in parts joined by hyphens,
 * with a digit. The tracker matches a reference whole, hyphens included: without them the same
 * characters name no shipment.
 */
export const ZMC_REFERENCE = /^(?=[A-Z-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const ZMC_MIN_LENGTH = 5;
export const ZMC_MAX_LENGTH = 40;

// A dash typed or pasted from a document, such as an en dash, is the reference's hyphen.
const DASHES = /[‐-―−]/g;

/** A reference that holds a hyphen, uppercased, without spaces and with one hyphen between its parts, as the tracker takes it. */
export function zmcReference(raw: string): string | undefined {
  const reference = raw.replace(/\s/g, '').replace(DASHES, '-').toUpperCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
  return reference.includes('-') && reference.length >= ZMC_MIN_LENGTH && reference.length <= ZMC_MAX_LENGTH
    && ZMC_REFERENCE.test(reference) ? reference : undefined;
}

/**
 * A JRS Express reference: the airbill number on the receipt, a hyphen, and the branch code (BC)
 * printed beside it. Both vary in length, so the digits alone do not give the reference back, and
 * the tracker finds a shipment only with both. A part of zeros alone is no airbill or branch.
 */
export const JRS_REFERENCE = /^(\d{1,10})-(\d{1,4})$/;

/** The reference as typed, without spaces, when it has JRS Express's shape. */
export function jrsReference(raw: string): string | undefined {
  const reference = raw.replace(/\s/g, '');
  const parts = JRS_REFERENCE.exec(reference);
  return parts && /[1-9]/.test(parts[1]!) && /[1-9]/.test(parts[2]!) ? reference : undefined;
}

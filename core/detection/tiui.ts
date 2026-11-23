/**
 * A Tiui folio: three groups of digits joined by hyphens, the first the merchant's. The groups'
 * lengths vary, so the digits alone do not give the folio back, and Tiui's tracker finds a folio
 * only with its hyphens.
 */
export const TIUI_FOLIO = /^\d{1,4}-\d{1,3}-\d{1,6}$/;

/** The folio as typed, without spaces, when it has Tiui's shape. */
export function tiuiFolio(raw: string): string | undefined {
  const folio = raw.replace(/\s/g, '');
  return TIUI_FOLIO.test(folio) ? folio : undefined;
}

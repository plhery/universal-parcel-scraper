/**
 * Deutsche Post Identcode check digit.
 *
 * What it is: the check used by the `"identcode"` detection rule on DHL
 * Paket's 12-digit parcel numbers, which are otherwise shared with FedEx,
 * Japan Post, Sagawa and others.
 * What it is not: no carrier lookup and no provider I/O. The caller passes an
 * already-normalized number; anything else fails the digits-only shape test.
 */

/**
 * Eleven digits and a modulo-10 check digit: weights 4, 9, 4, … from the
 * left, and the ten's complement of the sum, 0 when the sum is a multiple of
 * ten (Deutsche Post's Identcode and Leitcode check, as paketda.de's
 * "Paket-Prüfziffern" gives it for 12-digit DHL parcel numbers).
 */
export function isValidDhlIdentcode(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  const sum = [...value.slice(0, 11)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 9 : 4), 0);
  return (10 - (sum % 10)) % 10 === Number(value[11]);
}

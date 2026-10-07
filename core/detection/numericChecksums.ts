/** Check normalized numeric identifiers; a valid checksum does not identify a shipment. */

/** MyDHL+ uses the remainder of the first nine digits divided by seven. */
export function isValidDhlExpressWaybill(value: string): boolean {
  return value.length === 10 && /^\d{10}$/.test(value) && Number(value.slice(0, 9)) % 7 === Number(value[9]);
}

/** TNT ExpressConnect supports Mod 7 and Mod 11 for international consignments. */
export function isValidTntConsignmentNumber(value: string): boolean {
  if (value.length !== 9 || !/^\d{9}$/.test(value)) return false;
  const check = Number(value[8]);
  if (Number(value.slice(0, 8)) % 7 === check) return true;
  const weights = [8, 6, 4, 2, 3, 5, 9, 7];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  const digit = 11 - sum % 11;
  return (digit === 11 ? 5 : digit === 10 ? 0 : digit) === check;
}

/** GS1 mod 10: counted from the check digit, the digits before it weigh 3, 1, 3, … */
function hasGs1CheckDigit(value: string): boolean {
  const sum = [...value.slice(0, -1)].reverse()
    .reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === Number(value.at(-1));
}

/** The eMonitoring widget appends this GS1 digit to its 19-digit numeric alias. */
export function isValidPocztaPolskaBarcode(value: string): boolean {
  return value.length === 20 && /^\d{20}$/.test(value) && hasGs1CheckDigit(value);
}

/**
 * An SSCC behind its GS1 application identifier `00`, as freight labels print
 * it. Shippers issue SSCCs under their own company prefix, so a valid one names
 * no carrier.
 */
export function isValidSscc(value: string): boolean {
  return value.length === 20 && /^00\d{18}$/.test(value) && hasGs1CheckDigit(value);
}

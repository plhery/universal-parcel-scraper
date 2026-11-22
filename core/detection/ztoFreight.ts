/**
 * The ZTO Freight (中通快运) waybills its guest tracker answers: ZY and twelve or eighteen
 * digits, and twelve or twenty digits from 3 or 8. The tracker's page puts ZY in front of a
 * number that starts 2024, so a bare 2024 waybill reads as its ZY form.
 * Source: https://www.zto56.com/billsearch.html (its `ewbReg` rule and input placeholder).
 */
export function ztoFreightWaybill(raw: string): string | null {
  const number = typeof raw === 'string' ? raw.replace(/\s+/g, '').toUpperCase() : '';
  const prefixed = /^2024(?:\d{8}|\d{16})$/.test(number) ? `ZY${number}` : number;
  return /^(?:ZY(?:\d{12}|\d{18})|[38](?:\d{11}|\d{19}))$/.test(prefixed) ? prefixed : null;
}

/**
 * Check digits of numbers that carry letters.
 *
 * What it is: the validators of formats whose digits sit between a carrier's
 * letters and end in a check digit. Each is inferred from numbers, not taken
 * from a specification: it holds on every number of its format that the
 * carrier's own tracking has answered for, the public samples among them.
 * What it is not: no carrier choice and no shipment lookup. Each validator
 * receives the normalized number. The three that read a run of digits leave
 * the characters around it to the rule's pattern.
 */
import { hasGs1CheckDigit, hasLuhnCheckDigit } from './numericChecksums.js';
import { hasS10CheckDigit } from './s10CheckDigit.js';

/** The longest run of digits in the number, the first of them when two are as long. */
function longestDigitRun(value: string): string {
  return (value.match(/[0-9]+/g) ?? []).reduce((longest, run) => (run.length > longest.length ? run : longest), '');
}

/** S10's way to close a weighted sum: 11 minus the sum mod 11, where 10 is written 0 and 11 is written 5. */
function s10Closing(sum: number): number {
  const digit = 11 - (sum % 11);
  return digit === 10 ? 0 : digit === 11 ? 5 : digit;
}

/**
 * GS1 mod 10 over the longest run of digits, for a number that keeps its
 * check digit inside letters: 4PX's `4PX…CN` and YWE's `YWE…`.
 */
export function hasGs1CheckDigitInDigits(value: string): boolean {
  return hasGs1CheckDigit(longestDigitRun(value));
}

/** Luhn over the longest run of digits: Straightship's `STRCA` numbers and Commercive Parcel's `CMV` ones. */
export function hasLuhnCheckDigitInDigits(value: string): boolean {
  return hasLuhnCheckDigit(longestDigitRun(value));
}

/**
 * The nine digits after the leading letters are an S10 serial, eight digits
 * and their check digit: China Post's `ZA`, `ZC` and `ZS` numbers, which add
 * two digits, and Pengyou's `ZXA…PY`.
 */
export function startsWithS10Serial(value: string): boolean {
  const serial = /^[A-Z]*([0-9]{9})/.exec(value)?.[1];
  return serial !== undefined && hasS10CheckDigit(serial);
}

/**
 * GOFO's European waybills, `GF`, a country and fourteen digits. Counted from
 * the left, the second, fourth, … twelfth digits are doubled, nine less above
 * nine, and the fourteenth brings the sum to a multiple of ten. This is Luhn's
 * sum anchored at the left: Luhn itself doubles the other half of fourteen
 * digits. The digits open with the year and the day of the year. GOFO's
 * thirteen-digit numbers, its `CI` ones and its American `GFUS` waybills
 * carry no such digit.
 */
export function isValidGofoEuropeWaybill(value: string): boolean {
  if (!/^GF[A-Z]{2}[0-9]{14}$/.test(value)) return false;
  const digits = value.slice(4);
  const sum = [...digits.slice(0, 13)].reduce((total, digit, index) => {
    const counted = Number(digit) * (index % 2 ? 2 : 1);
    return total + (counted > 9 ? counted - 9 : counted);
  }, 0);
  return (10 - (sum % 10)) % 10 === Number(digits[13]);
}

/**
 * J&T Express Germany, `JTDE` and twelve digits whose third and fourth are 0.
 * The second, fifth, sixth, eighth, tenth and eleventh digits weigh 1, 5, 8,
 * 6, 7 and 3; the twelfth is 5 minus their sum, mod 11, and a result of 10 is
 * written 5. The other digits carry no weight. Like Saia's, the weights fit
 * the numbers and are not a published algorithm, so a number with another
 * third or fourth digit is not checked.
 */
export function isValidJAndTGermanyNumber(value: string): boolean {
  if (!/^JTDE[0-9]{2}00[0-9]{8}$/.test(value)) return false;
  const digits = [...value.slice(4)].map(Number);
  const weights = [0, 1, 0, 0, 5, 8, 0, 6, 0, 7, 3];
  const sum = weights.reduce((total, weight, index) => total + weight * digits[index]!, 0);
  const check = (((5 - sum) % 11) + 11) % 11;
  return digits[11] === (check === 10 ? 5 : check);
}

/**
 * Cainiao's French home-delivery numbers, four letters, thirteen digits and
 * `HD`: the fourth to twelfth digits weigh 8, 6, 4, 2, 3, 5, 9, 7, 1 and the
 * thirteenth closes their sum as S10's check digit does. The first three
 * digits are outside the sum.
 */
export function isValidCainiaoHdNumber(value: string): boolean {
  if (!/^[A-Z]{4}[0-9]{13}HD$/.test(value)) return false;
  const weights = [8, 6, 4, 2, 3, 5, 9, 7, 1];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(value[7 + index]), 0);
  return s10Closing(sum) === Number(value[16]);
}

/**
 * Australia Post's article ids: GS1 mod 10 over every character before the
 * last, in which a letter counts as its ASCII code (`A` is 65). On a number
 * without letters it is the GS1 check digit.
 */
export function isValidAustraliaPostArticleId(value: string): boolean {
  if (!/^[0-9A-Z]+[0-9]$/.test(value)) return false;
  const sum = [...value.slice(0, -1)].reverse().reduce((total, character, index) =>
    total + (/[0-9]/.test(character) ? Number(character) : character.charCodeAt(0)) * (index % 2 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === Number(value.at(-1));
}

/**
 * Poczta Polska's `PX` and ten digits: the first nine weigh 8, 6, 4, 2, 3, 5,
 * 9, 7, 8, S10's weights starting over at the ninth, and the tenth closes
 * their sum as S10's check digit does.
 */
export function isValidPocztaPolskaPxNumber(value: string): boolean {
  if (!/^PX[0-9]{10}$/.test(value)) return false;
  const weights = [8, 6, 4, 2, 3, 5, 9, 7, 8];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(value[2 + index]), 0);
  return s10Closing(sum) === Number(value[11]);
}

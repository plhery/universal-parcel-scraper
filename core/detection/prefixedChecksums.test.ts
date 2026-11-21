import { describe, expect, it } from 'vitest';
import { checksumRejections, detectCarrierMatch } from './detect.js';
import {
  hasGs1CheckDigitInDigits,
  hasLuhnCheckDigitInDigits,
  isValidAustraliaPostArticleId,
  isValidCainiaoHdNumber,
  isValidGofoEuropeWaybill,
  isValidJAndTGermanyNumber,
  isValidPocztaPolskaPxNumber,
  startsWithS10Serial,
} from './prefixedChecksums.js';

/** The number with its digit at `index` raised by one. */
const bump = (number: string, index: number) => number.slice(0, index) + String((Number(number.at(index)) + 1) % 10) + number.slice(index + 1 || number.length);

// Every number the validators accept below is a public sample of its carrier's corpus.
describe('check digits of numbers that carry letters', () => {
  it('reads the GS1 check digit of 4PX and YWE numbers in their digits', () => {
    for (const number of ['4PX3001521662170CN', '4PX3002790888841CN', '4PX3002555003946CN', '4XP3001521662170CN', 'YWE00001563351639']) {
      expect(hasGs1CheckDigitInDigits(number), number).toBe(true);
      expect(hasGs1CheckDigitInDigits(bump(number, 8)), number).toBe(false);
    }
    expect(hasGs1CheckDigitInDigits('4PXCN')).toBe(false);
    for (const number of ['4PX3001521662170CN', 'YWE00001563351639']) {
      expect(detectCarrierMatch(number).confidence, number).toBe('high');
      expect(detectCarrierMatch(bump(number, 8)), number).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    }
    expect(checksumRejections('4PX3001521662171CN')).toEqual([{ carrier: 'four-px', rule: 'four-px-1', checksum: 'gs1-digits' }]);
    expect(checksumRejections('4XP3001521662171CN')).toEqual([{ carrier: 'four-px', rule: 'four-px-swapped', checksum: 'gs1-digits' }]);
  });

  it('reads the Luhn check digit of Straightship STRCA numbers', () => {
    for (const number of ['STRCA6096486792700', 'STRCA3666462053476']) {
      expect(hasLuhnCheckDigitInDigits(number), number).toBe(true);
      expect(hasLuhnCheckDigitInDigits(bump(number, -1)), number).toBe(false);
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'straightship', confidence: 'high' });
    }
  });

  it('reads an S10 serial after the letters of China Post and Pengyou numbers', () => {
    for (const number of ['ZC00000000500', 'ZS00000000599', 'ZA19999999980', 'ZXA999999995PY', 'ZXA000000005PY']) expect(startsWithS10Serial(number), number).toBe(true);
    for (const number of ['ZC00000000000', 'ZS99999999980', 'ZXA999999970PY', 'ZC0000000', '1ZC00000000500']) expect(startsWithS10Serial(number), number).toBe(false);
    expect(detectCarrierMatch('ZXA999999995PY')).toMatchObject({ carrier: 'pengyou', confidence: 'high' });
    expect(detectCarrierMatch('ZXA999999970PY')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(checksumRejections('ZXA999999970PY')).toEqual([{ carrier: 'pengyou', rule: 'pengyou-2', checksum: 's10-serial' }]);
  });

  it('checks GOFO\'s European waybills from the left', () => {
    for (const number of ['GFFR26162070068751', 'GFIT26104011851374', 'GFNL26142036286842', 'GFNL26285136973694', 'GFES26222137816984', 'GFES26222140488459', 'GFIT25235026968385', 'GFIT25281018226016']) {
      expect(isValidGofoEuropeWaybill(number), number).toBe(true);
      for (const index of [6, 11, 17]) expect(isValidGofoEuropeWaybill(bump(number, index)), number).toBe(false);
    }
    // Thirteen digits, GOFO's CI numbers and its American waybills are other formats.
    for (const number of ['GFFR2616207006875', 'CIFR26162070068751', 'GF26162070068751']) expect(isValidGofoEuropeWaybill(number), number).toBe(false);
    expect(detectCarrierMatch('GFNL26142036286842')).toMatchObject({ carrier: 'gofo-nl', confidence: 'high' });
    expect(detectCarrierMatch('GFNL26142036286843')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(checksumRejections('GFNL26142036286843')).toEqual([{ carrier: 'gofo-nl', rule: 'gofo-nl-1', checksum: 'gofo-europe' }]);
    expect(detectCarrierMatch('GFIT25274004729927')).toMatchObject({ carrier: 'gofo-it', confidence: 'high' });
    expect(checksumRejections('GFFR99999999999980')).toEqual([{ carrier: 'gofo-fr', rule: 'gofo-fr-1', checksum: 'gofo-europe' }]);
    // The thirteen-digit numbers and the CI ones are not checked.
    for (const number of ['GFFR9999999999980', 'CIFR5207254188668', 'CIFR99999999999980', 'CIFR26999999999980']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'gofo-fr', confidence: 'high' });
      expect(checksumRejections(number), number).toEqual([]);
    }
  });

  it('checks J&T Express Germany numbers whose third and fourth digits are 0', () => {
    for (const number of ['JTDE900000979616', 'JTDE100027319088', 'JTDE100007312985']) {
      expect(isValidJAndTGermanyNumber(number), number).toBe(true);
      expect(isValidJAndTGermanyNumber(bump(number, -1)), number).toBe(false);
      expect(isValidJAndTGermanyNumber(bump(number, 9)), number).toBe(false);
      // The first digit carries no weight.
      expect(isValidJAndTGermanyNumber(bump(number, 4)), number).toBe(true);
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'j-and-t-de', confidence: 'high' });
      expect(checksumRejections(bump(number, -1)), number).toEqual([{ carrier: 'j-and-t-de', rule: 'j-and-t-de-1', checksum: 'j-and-t-de' }]);
    }
    // Another series is not checked.
    expect(isValidJAndTGermanyNumber('JTDE999999999980')).toBe(false);
    expect(detectCarrierMatch('JTDE999999999980')).toMatchObject({ carrier: 'j-and-t-de', confidence: 'high' });
    expect(checksumRejections('JTDE999999999980')).toEqual([]);
  });

  it('checks the 901 series of Cainiao\'s French home-delivery numbers', () => {
    for (const number of ['DOFR9010192105464HD', 'DOFR9010202101005HD', 'CNFR9010497138847HD', 'CNFR9010496456407HD']) {
      expect(isValidCainiaoHdNumber(number), number).toBe(true);
      expect(isValidCainiaoHdNumber(bump(number, 16)), number).toBe(false);
      expect(isValidCainiaoHdNumber(bump(number, 10)), number).toBe(false);
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'aliexpress', confidence: 'high' });
      expect(detectCarrierMatch(bump(number, 16)), number).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    }
    // Another series keeps its carrier unchecked.
    expect(detectCarrierMatch('DOFR9999999999980HD')).toMatchObject({ carrier: 'aliexpress', confidence: 'high' });
    expect(checksumRejections('DOFR9999999999980HD')).toEqual([]);
  });

  it('counts a letter of an Australia Post article ID as its ASCII code', () => {
    for (const number of ['7T2514965601000935102', '36GMB353861501000935107', 'ST2273888401000960300', '99722999536301000830908', '33QAG752421901000931500']) {
      expect(isValidAustraliaPostArticleId(number), number).toBe(true);
      expect(isValidAustraliaPostArticleId(bump(number, -1)), number).toBe(false);
      expect(isValidAustraliaPostArticleId(bump(number, 8)), number).toBe(false);
    }
    // A, 65, weighs as K, 75, does, and B does not.
    expect(isValidAustraliaPostArticleId('33QKG752421901000931500')).toBe(true);
    expect(isValidAustraliaPostArticleId('33QBG752421901000931500')).toBe(false);
    expect(isValidAustraliaPostArticleId('33qag752421901000931500')).toBe(false);
  });

  it('checks Poczta Polska PX numbers', () => {
    for (const number of ['PX0000000013', 'PX7678676761', 'PX2121532015', 'PX2140553297', 'PX2140539622']) {
      expect(isValidPocztaPolskaPxNumber(number), number).toBe(true);
      expect(isValidPocztaPolskaPxNumber(bump(number, -1)), number).toBe(false);
      expect(isValidPocztaPolskaPxNumber(bump(number, 10)), number).toBe(false);
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'poczta-polska', confidence: 'high' });
      expect(detectCarrierMatch(bump(number, -1)).candidates, number).not.toContain('poczta-polska');
    }
    for (const number of ['PX000000001', 'PX00000000013', 'PY0000000013']) expect(isValidPocztaPolskaPxNumber(number), number).toBe(false);
  });
});

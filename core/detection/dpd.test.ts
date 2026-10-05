import { describe, expect, it } from 'vitest';
import { dpdParcelNumber } from './dpd.js';

describe('DPD parcel number check character', () => {
  it('reads the fourteen digits with or without the printed character', () => {
    expect(dpdParcelNumber('12345678901234')).toBe('12345678901234');
    for (const [digits, character] of [['12345678901234', 'E'], ['00000000000000', 'U'], ['99999999999999', 'Z'], ['01234567890123', '3']]) {
      expect(dpdParcelNumber(`${digits}${character}`)).toBe(digits);
    }
  });

  it('refuses a character that does not match and any other length', () => {
    for (const value of ['12345678901234F', '123456789012343', '1234567890123', '1234567890123E', '12345678901234EE', '12345678901234e', '12345678901234\n']) {
      expect(dpdParcelNumber(value)).toBeNull();
    }
  });
});

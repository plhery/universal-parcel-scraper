import { describe, expect, it } from 'vitest';
import { normalizeCarrierInputs, normalizeDeliveryPostcode } from './inputs.js';
describe('universal recipient postcode', () => {
  it.each(['8000', '75001', 'SW1A 1AA', 'M5V 3L9', '1000-001'])('retains country-specific separators: %s', (postcode) => {
    expect(normalizeDeliveryPostcode(postcode.toLowerCase())).toBe(postcode);
  });
  it.each(['', 'ABC', '<script>123', '12', '1'.repeat(13), '123/456'])('rejects an invalid value', (postcode) => {
    expect(() => normalizeDeliveryPostcode(postcode)).toThrow(TypeError);
  });
});

describe('DPD Germany postcode', () => {
  it('keeps the postcode optional and retains leading zeroes when supplied', () => {
    expect(normalizeCarrierInputs('dpd-de', '01000000000001', '', '')).toEqual({ trackingUrl: null, postcode: null });
    expect(normalizeCarrierInputs('dpd-de', '01000000000001', '', ' 01001 ')).toEqual({ trackingUrl: null, postcode: '01001' });
  });
  it.each(['8000', '123456', 'ABCDE'])('rejects an invalid German postcode: %s', postcode => {
    expect(() => normalizeCarrierInputs('dpd-de', '01000000000001', '', postcode)).toThrow('five-digit delivery postcode');
  });
});

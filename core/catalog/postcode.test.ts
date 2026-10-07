import { describe, expect, it } from 'vitest';
import { carrierRequirements, requirementSatisfied } from './index.js';
import { normalizeCarrierInputs, normalizeDeliveryPostcode } from './inputs.js';
describe('universal recipient postcode', () => {
  it.each(['8000', '75001', 'SW1A 1AA', 'M5V 3L9', '1000-001'])('retains country-specific separators: %s', (postcode) => {
    expect(normalizeDeliveryPostcode(postcode.toLowerCase())).toBe(postcode);
  });
  it.each(['', 'ABC', '<script>123', '12', '1'.repeat(13), '123/456'])('rejects an invalid value', (postcode) => {
    expect(() => normalizeDeliveryPostcode(postcode)).toThrow(TypeError);
  });
});

describe('DPD postcode', () => {
  it('stays optional', () => {
    expect(normalizeCarrierInputs('dpd', '06080000000001', '', '')).toEqual({ trackingUrl: null, postcode: null });
  });
  it.each([
    ['8000', '8000'], [' 75001 ', '75001'], ['sw1a  1aa', 'SW1A 1AA'], ['1012 ab', '1012 AB'], ['00-001', '00-001'],
  ])('takes the postcode of any country DPD delivers in: %s', (typed, stored) => {
    expect(normalizeCarrierInputs('dpd', '06080000000001', '', typed)).toEqual({ trackingUrl: null, postcode: stored });
  });
  it.each(['12', 'ABCDE', '1'.repeat(13), '75001/2', '75 - 001'])('rejects what no country writes: %s', (postcode) => {
    expect(() => normalizeCarrierInputs('dpd', '06080000000001', '', postcode)).toThrow('DPD requires a valid delivery postcode');
  });
  it('asks the form for the same shape', () => {
    const [requirement] = carrierRequirements('dpd', '06080000000001');
    for (const value of ['8000', '75001', 'SW1A 1AA', 'sw1a 1aa', '1000-001']) expect(requirementSatisfied(requirement!, value)).toBe(true);
    for (const value of ['12', 'ABCDE', '1'.repeat(13), '75001/2']) expect(requirementSatisfied(requirement!, value)).toBe(false);
    // Browsers compile the field's pattern with the `v` flag.
    expect(() => new RegExp(requirement!.pattern!, 'v')).not.toThrow();
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

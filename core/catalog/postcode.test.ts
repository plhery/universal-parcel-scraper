import { describe, expect, it } from 'vitest';
import { normalizeDeliveryPostcode } from './inputs.js';
describe('universal recipient postcode', () => {
  it.each(['8000', '75001', 'SW1A 1AA', 'M5V 3L9', '1000-001'])('retains country-specific separators: %s', (postcode) => {
    expect(normalizeDeliveryPostcode(postcode.toLowerCase())).toBe(postcode);
  });
  it.each(['', 'ABC', '<script>123', '12', '1'.repeat(13), '123/456'])('rejects an invalid value', (postcode) => {
    expect(() => normalizeDeliveryPostcode(postcode)).toThrow(TypeError);
  });
});

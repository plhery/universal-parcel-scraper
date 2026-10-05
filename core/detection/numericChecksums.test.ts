import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { detectCarrierMatch, isValidDhlExpressWaybill, isValidPocztaPolskaBarcode, isValidTntConsignmentNumber } from './index.js';

describe('numeric checksum candidates', () => {
  it('prioritizes checksum-valid DHL Express waybills without assigning the carrier', () => {
    expect(isValidDhlExpressWaybill('1234567891')).toBe(true);
    expect(isValidDhlExpressWaybill('0000000070')).toBe(true);
    for (const number of ['1234567890', '1234567897', '123456789', '12345678910', '1234567891\n', '123 4567891']) {
      expect(isValidDhlExpressWaybill(number)).toBe(false);
    }
    expect(detectCarrierMatch('123 456-7891')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['dhl-express'] });
    expect(detectCarrierMatch('1234567891').candidates[0]).toBe('dhl-express');
    expect(recognitionAskedCarriers('1234567891')[0]).toBe('dhl-express');
    expect(recognitionCandidates('1234567891', { phase: 'browser' })[0]?.carrier).toBe('dhl-express');
    expect(detectCarrierMatch('1234567890').candidates).not.toContain('dhl-express');
    expect(recognitionAskedCarriers('1234567890')).not.toContain('dhl-express');
    expect(recognitionCandidates('1234567890', { phase: 'browser' })).toEqual([]);
    // A failed DHL check excludes that candidate, not other carriers' ten-digit formats.
    expect(detectCarrierMatch('1234567890').candidates).toEqual(expect.arrayContaining(['relais-colis', 'tipsa', 'dhl']));
  });

  it('accepts both TNT schemes, including Mod 11 substitutions and leading zeros', () => {
    for (const number of ['123456782', '123456785', '000000005', '000000080']) {
      expect(isValidTntConsignmentNumber(number)).toBe(true);
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['tnt'] });
      expect(recognitionAskedCarriers(number)[0]).toBe('tnt');
    }
    for (const number of ['123456789', '12345678', '1234567850', '123456785\n', '1234-56785']) {
      expect(isValidTntConsignmentNumber(number)).toBe(false);
    }
    expect(detectCarrierMatch('123456789').candidates).not.toContain('tnt');
    expect(detectCarrierMatch('1234-56785').preferred).toEqual(['tnt']);
    // The international check never gates TNT France's separate national format.
    expect(detectCarrierMatch('1234567890123456').candidates).toContain('tnt');
  });

  it('checks full Polish barcodes while preserving aliases without a check digit', () => {
    for (const number of ['12345678901234567890', '00000000000000000017']) {
      expect(isValidPocztaPolskaBarcode(number)).toBe(true);
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['poczta-polska'] });
      expect(recognitionAskedCarriers(number)[0]).toBe('poczta-polska');
    }
    for (const number of ['12345678901234567891', '1234567890123456789', '123456789012345678900', '12345678901234567890\n']) {
      expect(isValidPocztaPolskaBarcode(number)).toBe(false);
    }
    expect(detectCarrierMatch('12345678901234567891').candidates).not.toContain('poczta-polska');
    expect(detectCarrierMatch('1234567890123456789').candidates).toContain('poczta-polska');
    expect(detectCarrierMatch('PX1234567890')).toMatchObject({ carrier: 'poczta-polska', confidence: 'high' });
  });
});

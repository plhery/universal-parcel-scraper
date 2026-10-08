import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { isValidFedEx1DBarcode, isValidFedExGround96Barcode } from './fedex.js';
import { isValidDhlIdentcode } from './identcode.js';
import { detectCarrierMatch, isValidDhlExpressWaybill, isValidPocztaPolskaBarcode, isValidSscc, isValidTntConsignmentNumber } from './index.js';

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

  it('prefers FedEx for fifteen-digit Ground numbers that end in their GS1 check', () => {
    expect(detectCarrierMatch('449044304137821')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['fedex'] });
    expect(detectCarrierMatch('449 044 304 137 821').candidates[0]).toBe('fedex');
    expect(detectCarrierMatch('449044304137820').candidates).not.toContain('fedex');
    expect(detectCarrierMatch('449044304137820').candidates).toContain('yunda');
  });

  it('prefers FedEx for label barcodes whose embedded tracking number passes its check', () => {
    // Ground spec example: the GS1 check covers only the last fifteen digits.
    expect(isValidFedExGround96Barcode('9611020987654312345672')).toBe(true);
    expect(detectCarrierMatch('9611020987654312345672')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['fedex'] });
    expect(detectCarrierMatch('9611020987654312345672').candidates).toEqual(expect.arrayContaining(['austrian-post', 'usps']));
    // GSN chart example: a 12-digit Express number behind two zeros.
    expect(isValidFedEx1DBarcode('9622001560001234567100794808390594')).toBe(true);
    expect(detectCarrierMatch('9622 0015 6000 1234 5671 0079 4808 3905 94')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['fedex'] });
    for (const number of [
      '9611020987654312345673', // wrong check digit
      '9511020987654312345672', // not a 96 barcode
      '9622001560001234567100794808390595', // wrong check digit
      '9622001560001234567141794808390594', // 4 + 1 × 7 keeps a 13-digit sum but not the zeros
      '96220015600012345671794808390594', // zeros dropped
    ]) {
      expect(isValidFedExGround96Barcode(number) || isValidFedEx1DBarcode(number)).toBe(false);
      expect(detectCarrierMatch(number).candidates).not.toContain('fedex');
    }
  });

  it('checks full Polish barcodes while preserving aliases without a check digit', () => {
    for (const number of ['00159007731234567899', '00059007730000000007']) {
      expect(isValidPocztaPolskaBarcode(number)).toBe(true);
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['poczta-polska'] });
      expect(recognitionAskedCarriers(number)[0]).toBe('poczta-polska');
    }
    for (const number of ['12345678901234567891', '1234567890123456789', '123456789012345678900', '12345678901234567890\n']) {
      expect(isValidPocztaPolskaBarcode(number)).toBe(false);
    }
    expect(detectCarrierMatch('12345678901234567891').candidates).not.toContain('poczta-polska');
    expect(detectCarrierMatch('12345678901234567890').preferred).not.toContain('poczta-polska');
    expect(detectCarrierMatch('1234567890123456789').candidates).toContain('poczta-polska');
    expect(detectCarrierMatch('PX1234567890')).toMatchObject({ carrier: 'poczta-polska', confidence: 'high' });
  });

  it('suggests DHL for twelve digits that end in the Identcode check without assigning it', () => {
    // Worked examples of the public check-digit descriptions: weights 4 and 9 from the left.
    for (const number of ['218025809066', '201298452277', '000000000000']) expect(isValidDhlIdentcode(number)).toBe(true);
    for (const number of ['218025809065', '218025809060', '21802580906', '2180258090666', '218025809066\n', '21802 5809066']) {
      expect(isValidDhlIdentcode(number)).toBe(false);
    }
    expect(detectCarrierMatch('21.802 580.906 6')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('218025809066').candidates).toContain('dhl');
    expect(detectCarrierMatch('218025809066').preferred).not.toContain('dhl');
    expect(recognitionAskedCarriers('218025809066')).not.toContain('dhl');
    expect(detectCarrierMatch('218025809065').candidates).not.toContain('dhl');
    expect(detectCarrierMatch('218025809065').candidates.length).toBeGreaterThan(0);
  });

  it('asks Swiss Post Cargo about an SSCC behind its 00 identifier without assigning it', () => {
    expect(isValidSscc('00312345670000000016')).toBe(true);
    for (const number of ['00312345670000000017', '312345670000000016', '10312345670000000013', '00312345670000000016\n']) {
      expect(isValidSscc(number)).toBe(false);
    }
    expect(detectCarrierMatch('00 3 1234567 000000001 6')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('00312345670000000016').candidates).toContain('swiss-post-cargo');
    expect(recognitionAskedCarriers('00312345670000000016')).toContain('swiss-post-cargo');
    expect(detectCarrierMatch('00312345670000000017').candidates).not.toContain('swiss-post-cargo');
  });
});

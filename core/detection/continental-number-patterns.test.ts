import { describe, expect, it } from 'vitest';
import { recognitionCandidates, recognitionAskedCarriers } from '../catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from './index.js';
import { isPosteItalianeTrackingNumber } from './posteItaliane.js';

describe('continental shipment candidates', () => {
  it('offers BRT shipment numbers without assigning ownership from twelve digits', () => {
    const number = '990000000001';
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['brt']) });
    expect(recognitionCandidates(number)).toEqual(expect.arrayContaining([expect.objectContaining({ carrier: 'brt' })]));
    expect(parseTrackingInput(`Tracking number: ${number}`)).toMatchObject({ trackingNumber: number, carrier: 'unknown', confidence: 'low' });
  });

  it('prioritizes documented bpost prefixes while preserving overlapping numeric candidates', () => {
    for (const number of ['323200000000000001', '323200000000000000000001', '329900000000000000000001']) {
      const detected = detectCarrierMatch(number);
      expect(detected).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['bpost'] });
      expect(detected.candidates[0]).toBe('bpost');
      expect(recognitionAskedCarriers(number)[0]).toBe('bpost');
      expect(detected.candidates.length).toBeGreaterThan(1);
    }
    for (const number of ['600000000000000000000001', '32320000000000001', '3232000000000000000000001']) {
      expect(detectCarrierMatch(number).preferred).not.toContain('bpost');
    }
  });

  it('sends whole SDA candidates through Poste recognition and rejects truncated families', () => {
    for (const number of ['990001A000001', '3C9900A000001', '990A00000001A']) {
      expect(isPosteItalianeTrackingNumber(number)).toBe(true);
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['poste-italiane'] });
      expect(recognitionAskedCarriers(number)).toEqual(['poste-italiane']);
      expect(parseTrackingInput(`Tracking number: ${number}`)).toMatchObject({ trackingNumber: number, carrier: 'unknown', candidates: ['poste-italiane'] });
      expect(isPosteItalianeTrackingNumber(number.slice(1))).toBe(false);
    }
    expect(isPosteItalianeTrackingNumber('ABCDEF0000001')).toBe(false);
  });

  it('retains the historical PostNL id for its complete 3S barcode', () => {
    expect(detectCarrierMatch('3SZZZZ1000001')).toMatchObject({ carrier: 'spring-gds', confidence: 'high' });
    expect(recognitionAskedCarriers('3SZZZZ1000001')).toEqual([]);
  });
});

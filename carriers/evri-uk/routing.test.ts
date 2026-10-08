import { describe, expect, it } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';

// A shared barcode shape establishes the brand, not its tracking service.
const NUMBER = 'H000000000000008';

describe('Evri service routing', () => {
  it('keeps a bare barcode ambiguous between domestic and international services', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({
      carrier: 'unknown', confidence: 'low', candidates: expect.arrayContaining(['evri', 'evri-uk', 'hermes-de']),
    });
  });

  it('offers the domestic service alone for its C00HHA barcodes', () => {
    expect(detectCarrierMatch('C00HHA0000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['evri-uk'] });
    expect(detectCarrierMatch('COOHHA0000000001').candidates).not.toContain('evri-uk');
  });

  it.each([16, 17, 18, 19])('preserves Hermes recognition outside the Evri overlap: H plus %i digits', digits => {
    expect(detectCarrierMatch(`H${'0'.repeat(digits)}`)).toMatchObject({ carrier: 'hermes-de', confidence: 'high' });
  });

  it('binds the domestic service to its explicit parcel-details link', () => {
    expect(parseTrackingInput(`https://www.evri.com/track/parcel/${NUMBER}/details`)).toMatchObject({
      carrier: 'evri-uk', confidence: 'high', trackingNumber: NUMBER, source: 'link',
    });
  });

  it('binds Hermes Germany to its explicit tracking link despite the shared barcode', () => {
    expect(parseTrackingInput(`https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${NUMBER}`)).toMatchObject({
      carrier: 'hermes-de', confidence: 'high', trackingNumber: NUMBER, source: 'link',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { detectCarrierMatch, parseTrackingInput } from './index.js';

describe('evidence-backed tracking formats', () => {
  it.each(['87001234567890A', '88001234567890Y'])('keeps the tracked-mail key in %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'la-poste', confidence: 'high' });
    expect(parseTrackingInput(`Suivi : ${number}`)).toMatchObject({
      trackingNumber: number, carrier: 'la-poste', confidence: 'high', source: 'text',
    });
    expect(parseTrackingInput(`https://www.laposte.fr/outils/suivre-vos-envois?code=${number}`))
      .toMatchObject({ trackingNumber: number, carrier: 'la-poste', source: 'link' });
  });

  it('bounds the tracked-mail rule to its evidenced prefixes and length', () => {
    for (const number of ['89001234567890A', '8800123456789A', '880012345678901A']) {
      expect(detectCarrierMatch(number).carrier).not.toBe('la-poste');
    }
  });

  it.each(['5N12345678901', '5Z12345678901'])('recognizes the documented Colissimo family: %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'la-poste', confidence: 'high' });
  });

  it('routes Canadian postal identifiers only when their checksum passes', () => {
    expect(parseTrackingInput('EE 123 456 785 CA')).toMatchObject({ carrier: 'canada-post', confidence: 'high' });
    expect(detectCarrierMatch('EE123456785CA').candidates).not.toContain('intl-post');
    expect(detectCarrierMatch('EE123456789CA').candidates).not.toContain('canada-post');
  });

  it('keeps a Relais Colis numeric parcel ambiguous', () => {
    expect(detectCarrierMatch('12345678901234')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('12345678901234').candidates).toContain('relais-colis');
  });

  it('offers a normalized legacy DTDC reference without selecting it', () => {
    expect(detectCarrierMatch('v12345678')).toMatchObject({
      carrier: 'unknown', confidence: 'low', candidates: ['dtdc'],
    });
    expect(detectCarrierMatch('V1234567').candidates).not.toContain('dtdc');
    expect(detectCarrierMatch('V123456789').candidates).not.toContain('dtdc');
  });

  it('keeps a shared DHL family ambiguous without changing GM routing', () => {
    expect(detectCarrierMatch('JVGL01234567890123456789')).toMatchObject({
      carrier: 'unknown', confidence: 'low', candidates: ['dhl', 'dhl-ecommerce'],
    });
    expect(parseTrackingInput('https://www.dhl.com/ch-en/home/tracking.html?tracking-id=JVGL01234567890123456789&submit=1'))
      .toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhl', 'dhl-ecommerce'], source: 'link' });
    expect(parseTrackingInput('https://www.dhl.de/en/privatkunden/dhl-sendungsverfolgung.html?piececode=JVGL01234567890123456789'))
      .toMatchObject({ carrier: 'dhl', confidence: 'high', source: 'link' });
    expect(detectCarrierMatch('GM1234567890123456')).toMatchObject({ carrier: 'dhl-ecommerce', confidence: 'high' });
  });

  it('does not infer a GLS country or Aramex service from a short reference', () => {
    expect(detectCarrierMatch('ABCDEF')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(detectCarrierMatch('9680123456').candidates).not.toContain('aramex');
  });
});

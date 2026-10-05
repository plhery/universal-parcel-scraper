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

  it.each(['JX1234567890', 'jx 1234 5678 90'])('selects J&T for its Indonesian JX waybill: %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'j-and-t', confidence: 'high' });
  });

  it('bounds the JX and Ninja Van families to their reported lengths', () => {
    expect(detectCarrierMatch('NJVTT12345678901')).toMatchObject({ carrier: 'ninja-van', confidence: 'high' });
    for (const number of ['JX123456789', 'JX12345678901', 'NJVTT1234567890', 'NJVTT123456789012', 'NJVAB12345678901']) {
      expect(detectCarrierMatch(number).candidates).not.toContain(number.startsWith('JX') ? 'j-and-t' : 'ninja-van');
    }
  });

  it('suggests J&T for its other two-letter waybills without selecting it', () => {
    for (const number of ['JP1234567890', 'JO1234567890', 'JT1234567890']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['colis-prive', 'j-and-t'] });
    }
    expect(detectCarrierMatch('J11234567890').candidates).not.toContain('j-and-t');
  });

  it('offers Correos Express for a 23-digit reference and nothing shorter or longer', () => {
    expect(detectCarrierMatch('90000000000000000000001')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['correos-express'] });
    expect(detectCarrierMatch('9000000000000000000001').candidates).not.toContain('correos-express');
    expect(detectCarrierMatch('900000000000000000000001').candidates).not.toContain('correos-express');
  });

  it('selects CNE for its own family and only suggests the carriers of shared ones', () => {
    expect(detectCarrierMatch('3a5v 123456789')).toMatchObject({ carrier: 'cne', confidence: 'high' });
    expect(detectCarrierMatch('3A5V12345678').carrier).toBe('unknown');
    expect(detectCarrierMatch('CRIN26010112345678')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['intelcom'] });
    expect(detectCarrierMatch('CNG00123456789012')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['aliexpress', 'colis-prive'] });
  });

  it('keeps the 000010 account ambiguous between TIPSA and CTT Express', () => {
    const shared = detectCarrierMatch('0000100000101234567890');
    expect(shared).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['tipsa'] });
    expect(shared.candidates).toEqual(expect.arrayContaining(['tipsa', 'ctt-express']));
    expect(detectCarrierMatch('0082800082801234567890')).toMatchObject({ carrier: 'ctt-express', confidence: 'high' });
    expect(detectCarrierMatch('0000100000101234567890001')).toMatchObject({ carrier: 'ctt-express', confidence: 'high' });
  });

  it('selects Posti for its 21-character parcel ID', () => {
    expect(detectCarrierMatch('JJFI 654321 55555123456')).toMatchObject({ carrier: 'posti', confidence: 'high' });
    for (const number of ['JJFI6543215555512345', 'JJFI654321555551234567', 'JJSE65432155555123456']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('posti');
    }
  });

  it('suggests Ukrposhta for a thirteen-digit domestic barcode among the carriers sharing that length', () => {
    const match = detectCarrierMatch('0500000000001');
    expect(match).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(match.candidates).toEqual(expect.arrayContaining(['ukrposhta', 'la-poste']));
    expect(detectCarrierMatch('050000000001').candidates).not.toContain('ukrposhta');
  });

  it('offers UPS for an H waybill without selecting it', () => {
    expect(detectCarrierMatch('H1234567890')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['ups', 'dtdc'] });
    expect(detectCarrierMatch('A1234567890').candidates).not.toContain('ups');
  });

  it('does not infer a GLS country or Aramex service from a short reference', () => {
    expect(detectCarrierMatch('ABCDEF')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    expect(detectCarrierMatch('9680123456').candidates).not.toContain('aramex');
  });
});

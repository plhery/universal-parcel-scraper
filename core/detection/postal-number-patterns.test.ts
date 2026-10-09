import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { isCttExpressTrackingNumber } from './cttExpress.js';
import { checksumRejections, detectCarrierMatch } from './index.js';

describe('S10-shaped numbers', () => {
  it.each(['RR123456785TY', 'RR123456785MI', 'RR123456785YW', 'RR123456785CS'])(
    'leaves %s out of international mail: its suffix names no issuing country',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates).not.toContain('intl-post');
      expect(recognitionAskedCarriers(number)).not.toContain('intl-post');
      expect(checksumRejections(number)).toEqual([]);
    },
  );

  it('keeps a country suffix with no dedicated post in international mail', () => {
    expect(detectCarrierMatch('RR123456785EE')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
  });

  it('asks Poczta Polska first about a Polish-issued number without selecting it', () => {
    expect(detectCarrierMatch('cp 123 456 785 pl')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionCandidates('cp 123 456 785 pl')).toEqual([
      { carrier: 'poczta-polska', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionAskedCarriers('CP123456789PL')).not.toContain('poczta-polska');
  });

  it('offers USPS a US-issued number in the browser phase only', () => {
    expect(detectCarrierMatch('EC123456785US')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionAskedCarriers('EC123456785US')).not.toContain('usps');
    expect(recognitionCandidates('EC123456785US', { phase: 'browser' })).toEqual([
      { carrier: 'usps', needsInput: null, preferred: true },
    ]);
    expect(recognitionCandidates('EC123456789US', { phase: 'browser' })).toEqual([]);
    // Asendia USA's own numbers keep their carrier.
    expect(detectCarrierMatch('AS123456785US')).toMatchObject({ carrier: 'asendia', confidence: 'high' });
    expect(recognitionCandidates('AS123456785US', { phase: 'browser' })).toEqual([]);
  });
});

describe('Korea Post domestic numbers', () => {
  it('suggests Korea Post for thirteen digits that start with 1 to 6', () => {
    for (const number of ['1000000000001', '3000000000001', '5000000000001', '6000000000001']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates).toContain('korea-post');
    }
    for (const number of ['0000000000001', '7000000000001', '100000000001', '10000000000001']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('korea-post');
    }
  });
});

describe('Nordic SSCCs behind the 00 identifier', () => {
  it.each(['00357123456789012348', '00073123456789012347', '00573123456789012342'])(
    'lists PostNord first for %s, a Danish or Swedish GS1 prefix',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates[0]).toBe('postnord');
    },
  );

  it('keeps PostNord out when the SSCC check digit fails', () => {
    expect(detectCarrierMatch('00357123456789012349').candidates).not.toContain('postnord');
    expect(checksumRejections('00357123456789012349')).toEqual(expect.arrayContaining([
      { carrier: 'postnord', rule: 'postnord-5', checksum: 'sscc' },
      { carrier: 'postnord', rule: 'postnord-3', checksum: 'sscc' },
    ]));
  });

  it.each(['00370123456789012347', '00373123456789012348'])('keeps Bring first for its parcel SSCC %s', (number) => {
    const { candidates } = detectCarrierMatch(number);
    expect(candidates[0]).toBe('bring-posten');
    expect(candidates).toContain('postnord');
  });

  it('lists and asks Posti first for a Finnish GS1 prefix', () => {
    expect(detectCarrierMatch('00264123456789012349')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('00264123456789012349').candidates[0]).toBe('posti');
    expect(recognitionAskedCarriers('00264123456789012349')[0]).toBe('posti');
    for (const number of ['00264123456789012340', '00265123456789012346']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('posti');
    }
  });
});

describe('Australia Post barcodes', () => {
  it('keeps CTT Express to references whose two agency codes start with 00', () => {
    expect(isCttExpressTrackingNumber('0001001234567812340995')).toBe(false);
    expect(detectCarrierMatch('0001001234567812340995').candidates).not.toContain('ctt-express');
    expect(detectCarrierMatch('0082800082801234567890')).toMatchObject({ carrier: 'ctt-express', confidence: 'high' });
    expect(detectCarrierMatch('0082800082801234567890001')).toMatchObject({ carrier: 'ctt-express', confidence: 'high' });
  });

  it.each(['33ABC123456701000935106', 'XY1234567801000935107'])('selects Australia Post for the article ID %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
  });

  it('selects Australia Post for an all-digit article ID that also passes the GS1 check', () => {
    expect(detectCarrierMatch('99722123456701000830900')).toMatchObject({ carrier: 'australia-post', confidence: 'high' });
    expect(detectCarrierMatch('90000000000000123000001')).toMatchObject({ carrier: 'unknown', candidates: ['correos-express'] });
  });

  it('suggests Australia Post for a consignment number whose location ID has a letter', () => {
    expect(detectCarrierMatch('33ABC1234567')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('343AY1234567').candidates).toContain('australia-post');
    expect(detectCarrierMatch('331231234567').candidates).not.toContain('australia-post');
  });
});

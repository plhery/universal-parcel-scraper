import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
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

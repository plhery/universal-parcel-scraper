import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers } from '../catalog/recognition.js';
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
});

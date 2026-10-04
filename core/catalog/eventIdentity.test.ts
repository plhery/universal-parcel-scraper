import { describe, expect, it } from 'vitest';
import { sameInstantIdentityPolicy } from '../../app.js';

describe('same-instant identity policies', () => {
  it('requires India Post scans to retain their provider code', () => {
    expect(sameInstantIdentityPolicy('india-post')).toEqual({
      sourceCarrierId: 'india-post', storedSources: ['india-post'], requireProviderCode: true,
    });
  });

  it('keeps DPD postcode variants and universal copies eligible', () => {
    expect(sameInstantIdentityPolicy('dpd')).toEqual({
      sourceCarrierId: 'dpd', storedSources: ['dpd', 'unknown'], requireProviderCode: false,
    });
  });

  it.each(['unknown', 'dpd-fr', 'dhl', '', 'toString'])('does not opt in %s', (source) => {
    expect(sameInstantIdentityPolicy(source)).toBeUndefined();
  });
});

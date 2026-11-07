import { describe, expect, it } from 'vitest';
import { deliveryHandoff, hasDirectHandoffAdapter } from '../catalog/handoff.js';
import { recognitionCandidates } from '../catalog/recognition.js';
import { detectCarrierMatch } from './detect.js';
import { isSeinoSuperExpressReference } from './seinoSuperExpress.js';

describe('Seino Super Express eligibility without numeric ownership', () => {
  it.each(['1234567890', '0001234567890', '000001234567890', '1234-567-890'])('accepts its published whole query layouts: %s', number => {
    expect(isSeinoSuperExpressReference(number)).toBe(true);
  });
  it.each(['123456789', '12345678901', '123456789012', '12345678901234', 'AA123456789JP', 'ABC1234567'])('refuses other layouts: %s', number => {
    expect(isSeinoSuperExpressReference(number)).toBe(false);
    expect(hasDirectHandoffAdapter('seino-super-express', number)).toBe(false);
  });
  it('permits a named, supported handoff and leaves detection and HTTP recognition alone', () => {
    expect(deliveryHandoff('unknown', 'ORIGIN12345', { delivery_carrier: 'seino-super-express', delivery_tracking_number: '1234567890' }))
      .toEqual({ carrier: 'seino-super-express', number: '1234567890', basis: 'partner' });
    expect(deliveryHandoff('unknown', 'ORIGIN12345', { delivery_carrier: 'seino-super-express', delivery_tracking_number: 'AA123456789JP' })).toBeNull();
    expect(detectCarrierMatch('1234567890').candidates).not.toContain('seino-super-express');
    expect(recognitionCandidates('1234567890').map(c => c.carrier)).not.toContain('seino-super-express');
  });
});

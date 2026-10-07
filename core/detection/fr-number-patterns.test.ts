import { describe, expect, it } from 'vitest';
import { recognitionAskedCarriers, recognitionCandidates } from '../catalog/recognition.js';
import { detectCarrierMatch } from './detect.js';
import { normalizeRelaisColisTrackingNumber } from '../../carriers/relais-colis/adapter.js';
import { settleRecognition, type RecognitionOutcome } from '../recognition/index.js';

describe('French carrier number candidates', () => {
  it('asks Relais Colis about the complete VD family while preserving its overlap', () => {
    const number = 'VD1234567890';
    expect(detectCarrierMatch(number)).toMatchObject({
      carrier: 'unknown', confidence: 'low',
      candidates: expect.arrayContaining(['colis-prive', 'relais-colis']),
    });
    expect(recognitionAskedCarriers(number)).toContain('relais-colis');
    expect(normalizeRelaisColisTrackingNumber('vd 12345-67890')).toBe(number);
    for (const nearMiss of ['VD123456789', 'VD12345678901', 'VD123456789X']) {
      expect(detectCarrierMatch(nearMiss).candidates).not.toContain('relais-colis');
    }
  });

  it('offers GLS France to HTTP recognition for shared numeric and alpha references', () => {
    for (const number of ['36631000001', '366310000017', 'A1B2C3D4']) {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(recognitionAskedCarriers(number)).toContain('gls-fr');
      expect(recognitionCandidates(number, { phase: 'browser' }).map(({ carrier }) => carrier)).not.toContain('gls-fr');
    }
  });

  it('settles a French endpoint confirmation ahead of the shared GLS group answer', () => {
    const matches: RecognitionOutcome[] = recognitionCandidates('A1B2C3D4')
      .filter(({ carrier }) => ['gls-ch', 'gls-fr'].includes(carrier))
      .map((candidate) => ({ ...candidate, status: 'known', lastActivityAt: '2026-09-09T10:00:00Z' }));
    expect(matches.map(({ carrier }) => carrier)).toEqual(['gls-fr', 'gls-ch']);
    expect(settleRecognition(matches, new Date('2026-09-10T12:00:00Z'))).toEqual({ carrier: 'gls-fr', choices: [] });
  });
});

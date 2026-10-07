import { describe, expect, it } from 'vitest';
import { detectCarrierMatch } from '../detection/detect.js';
import { recognitionCandidates, recognitionNumberShape, recognizeAll, settleRecognition, type RecognitionOutcome } from './index.js';
import { recognitionAskedCarriers } from '../catalog/recognition.js';

const outcome = (carrier: string, status: RecognitionOutcome['status'], extra: Partial<RecognitionOutcome> = {}): RecognitionOutcome => ({
  carrier, status, needsInput: null, preferred: false, lastActivityAt: null, ...extra,
});
const now = new Date('2026-09-10T12:00:00Z');

describe('recognition candidates', () => {
  it('orders eligible candidates by region without claiming ownership or changing detection', () => {
    const number = '12345678901231';
    const detected = detectCarrierMatch(number);
    const baseline = recognitionCandidates(number);
    const local = recognitionCandidates(number, { countryHint: ' gb ' });
    expect(local[0]?.carrier).toBe('dhl-ecommerce-uk');
    expect(local.map(({ carrier }) => carrier).sort()).toEqual(baseline.map(({ carrier }) => carrier).sort());
    expect(detectCarrierMatch(number)).toEqual(detected);
    expect(recognitionAskedCarriers(number, { countryHint: 'GB' })).toContain('dhl-ecommerce-uk');
    expect(recognitionCandidates(number, { countryHint: 'United Kingdom' })).toEqual(baseline);
    expect(recognitionCandidates(number, { countryHint: 'XX' })).toEqual(baseline);
    expect(recognitionCandidates('1Z999AA10123456784', { countryHint: 'GB', priorities: { dpd: 1e6 } })).toEqual([]);
  });

  it('keeps direct hints and number evidence ahead of weak ordering hints', () => {
    expect(recognitionCandidates('06080000000002', { countryHint: 'GB', priorities: { 'dhl-ecommerce-uk': 1e6 } })[0]?.carrier).toBe('dpd');
    expect(recognitionCandidates('06080000000002', { hint: 'seur', countryHint: 'GB' })[0]?.carrier).toBe('seur');
    const shadowed = recognitionCandidates('10000000000001', { countryHint: 'CH', priorities: { dpd: 1e6 } });
    expect(shadowed.map(({ carrier }) => carrier)).not.toContain('dpd');
  });

  it('uses finite aggregate priorities within the eligible catalog and preserves phase boundaries', () => {
    const number = '12345678901231';
    expect(recognitionCandidates(number, { priorities: { ciblex: 20, seur: 10, ups: 1e6 } }).map(({ carrier }) => carrier).slice(0, 2)).toEqual(['ciblex', 'seur']);
    expect(recognitionCandidates(number, { priorities: { ciblex: NaN, seur: Infinity, brt: -10 } })).toEqual(recognitionCandidates(number));
    expect(recognitionCandidates(number, { countryHint: 'GB', priorities: { ciblex: 1e6 } })[0]?.carrier).toBe('dhl-ecommerce-uk');
    expect(recognitionCandidates('000000000001', { countryHint: 'US', priorities: { fedex: 1e6 } }).map(({ carrier }) => carrier)).not.toContain('fedex');
    expect(recognitionCandidates('000000000001', { phase: 'browser', countryHint: 'US', priorities: { fedex: 1 } }).map(({ carrier }) => carrier)).toEqual(['fedex']);
  });

  it('retains only character classes and run lengths in aggregate shapes', () => {
    expect(recognitionNumberShape('ab 123.456-789 xy')).toBe('A2D9A2');
    expect(recognitionNumberShape('00000000000001')).toBe('D14');
    expect(recognitionNumberShape('ABCDEF')).toBe('A6');
    expect(recognitionNumberShape('ABC')).toBeUndefined();
    expect(recognitionNumberShape('1234?')).toBeUndefined();
    expect(recognitionNumberShape('1'.repeat(41))).toBeUndefined();
  });

  it('keeps the carriers that can answer, hint first, then number evidence, then popularity', () => {
    expect(recognitionCandidates('12345678901231').map((candidate) => candidate.carrier)).toEqual(['dpd', 'seur', 'brt', 'hermes-de', 'relais-colis', 'ciblex', 'dhl-ecommerce-uk', 'delhivery']);
    expect(recognitionCandidates('06080000000002')).toEqual([
      { carrier: 'dpd', needsInput: null, preferred: true },
      { carrier: 'seur', needsInput: null, preferred: false },
      { carrier: 'brt', needsInput: null, preferred: false },
      { carrier: 'relais-colis', needsInput: null, preferred: false },
      { carrier: 'ciblex', needsInput: null, preferred: false },
      { carrier: 'dhl-ecommerce-uk', needsInput: null, preferred: false },
      { carrier: 'delhivery', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('12345678901', { hint: 'gls-de' })).toEqual([
      { carrier: 'gls-de', needsInput: 'postcode', preferred: false },
      { carrier: 'gls-fr', needsInput: null, preferred: false },
      { carrier: 'gls-ch', needsInput: 'postcode', preferred: false },
      { carrier: 'postlogistics', needsInput: null, preferred: false },
      { carrier: 'dhl-ecommerce-pl', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('06080000000002', { skip: (carrier) => carrier === 'dpd' }).map((candidate) => candidate.carrier))
      .toEqual(['seur', 'brt', 'relais-colis', 'ciblex', 'dhl-ecommerce-uk', 'delhivery']);
    // A selected carrier needs no recognition.
    expect(recognitionCandidates('1Z999AA10123456784')).toEqual([]);
    // A DPD France depot: DPD France cannot be asked, and DPD Switzerland's
    // group-wide answer would file its parcel under the wrong network.
    expect(recognitionCandidates('10000000000001').map((candidate) => candidate.carrier)).toEqual(['seur', 'brt', 'relais-colis', 'ciblex', 'dhl-ecommerce-uk', 'delhivery']);
  });

  it('can ask bpost about an ambiguous numeric barcode without a recipient postcode', () => {
    expect(recognitionCandidates('000000000000000000000001')).toEqual(expect.arrayContaining([
      { carrier: 'bpost', needsInput: null, preferred: false },
    ]));
  });

  it('confirms direct postal candidates before the unknown-postal fallback', () => {
    // Finnish issuance is number evidence for a lookup, not proof of delivery.
    expect(detectCarrierMatch('CE123456785FI')).toMatchObject({ carrier: 'intl-post', confidence: 'high' });
    expect(recognitionCandidates('ce 123.456-785 fi')).toEqual([
      { carrier: 'posti', needsInput: null, preferred: true },
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('XR123456785TS')).toEqual([
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('CE123456785FI', { hint: 'chronopost' }).map(({ carrier }) => carrier))
      .toEqual(['chronopost', 'posti']);
    expect(recognitionCandidates('CE123456785FI', { skip: (carrier) => carrier === 'posti' }).map(({ carrier }) => carrier))
      .toEqual(['chronopost']);
  });

  it('does not infer Posti from a failed postal checksum or probe a known direct postal carrier', () => {
    expect(recognitionCandidates('CE123456789FI').map(({ carrier }) => carrier)).not.toContain('posti');
    // Chronopost accepts proprietary aliases with the same shape, which need
    // not have an S10 checksum. Its lookup still has to confirm the identity.
    expect(recognitionCandidates('HL123456789JB')).toEqual([
      { carrier: 'chronopost', needsInput: null, preferred: false },
    ]);
    expect(recognitionCandidates('RA123456785CH')).toEqual([]);
  });
});

describe('asking carriers', () => {
  it('keeps browser checks separate from HTTP checks', () => {
    expect(recognitionCandidates('000000000001').map(({ carrier }) => carrier)).not.toContain('fedex');
    expect(recognitionCandidates('000000000001', { phase: 'browser' }).map(({ carrier }) => carrier)).toEqual(['fedex']);
    expect(recognitionCandidates('33870000000000001', { phase: 'browser' }).map(({ carrier }) => carrier)).toEqual(['dhl-ecommerce']);
  });
  it('aborts callbacks at the deadline and on caller cancellation', async () => {
    let seen: AbortSignal | undefined;
    const candidates = recognitionCandidates('000000000001', { phase: 'browser' });
    const outcomes = await recognizeAll(candidates, async (_carrier, context) => {
      seen = context.signal;
      return new Promise(() => undefined);
    }, 10);
    expect(seen?.aborted).toBe(true);
    expect(outcomes[0]?.status).toBe('failed');
    const controller = new AbortController();
    const request = recognizeAll(candidates, async (_carrier, context) => {
      seen = context.signal;
      return new Promise(() => undefined);
    }, 10_000, controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
  });
  it('asks all at once and treats a failure or a late answer as no answer', async () => {
    const started: string[] = [];
    const outcomes = await recognizeAll(recognitionCandidates('12345678901231'), async (carrier) => {
      started.push(carrier);
      if (carrier === 'dpd') return { known: true, lastActivityAt: '2026-09-09T08:00:00Z' };
      if (carrier === 'hermes-de') throw new Error('upstream down');
      if (carrier === 'seur' || carrier === 'brt') return { known: false };
      return new Promise(() => undefined);
    }, 20);
    expect(started).toEqual(['dpd', 'seur', 'brt', 'hermes-de', 'relais-colis', 'ciblex', 'dhl-ecommerce-uk', 'delhivery']);
    expect(outcomes.map(({ carrier, status }) => [carrier, status])).toEqual([
      ['dpd', 'known'], ['seur', 'unknown'], ['brt', 'unknown'], ['hermes-de', 'failed'], ['relais-colis', 'failed'], ['ciblex', 'failed'], ['dhl-ecommerce-uk', 'failed'], ['delhivery', 'failed'],
    ]);
    expect(outcomes[0]!.lastActivityAt).toBe('2026-09-09T08:00:00Z');
  });
});

describe('settling on a carrier', () => {
  it('picks the only recent answer', () => {
    expect(settleRecognition([outcome('dpd', 'known'), outcome('ciblex', 'unknown'), outcome('hermes-de', 'failed')], now))
      .toEqual({ carrier: 'dpd', choices: [] });
    expect(settleRecognition([outcome('dpd', 'known', { lastActivityAt: '2026-01-02T00:00:00Z' }), outcome('ciblex', 'known')], now))
      .toEqual({ carrier: 'ciblex', choices: [] });
    expect(settleRecognition([outcome('dpd', 'unknown')], now)).toEqual({ choices: [] });
  });
  it('prefers number evidence, then one brand\'s most common network, and otherwise lets the user choose', () => {
    expect(settleRecognition([outcome('dpd', 'known', { preferred: true }), outcome('ciblex', 'known')], now))
      .toEqual({ carrier: 'dpd', choices: [] });
    expect(settleRecognition([outcome('gls-de', 'known'), outcome('gls-ch', 'known')], now))
      .toEqual({ carrier: 'gls-ch', choices: [] });
    expect(settleRecognition([outcome('dpd', 'known'), outcome('hermes-de', 'known')], now))
      .toEqual({ choices: ['dpd', 'hermes-de'] });
    expect(settleRecognition([outcome('seur', 'known'), outcome('brt', 'known')], now))
      .toEqual({ choices: ['seur', 'brt'] });
  });
});

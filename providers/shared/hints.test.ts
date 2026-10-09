import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../core/adapter/index.js';
import { checksumRejections } from '../../core/detection/index.js';
import { carrierErrorKind } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { REGISTRY } from '../../generated/registry.js';
import { ADAPTER_CHECKED_RULES, brandCarrierForNumber, universalCarrierHints } from './hints.js';

/** Synthetic numbers that fit each adapter-checked rule but fail its check digit. */
const FAILING: Record<string, string> = {
  'dhl-express-waybill': '1234567890', 'gls-fr-4': '123456789010', 'mondial-relay-1': '12345678901234567890123450',
  'fedex-3': '9611020987654312345673', 'fedex-4': '9622001560001234567100794808390595',
  'an-post-1': 'RR123456789IE', 'austrian-post-2': 'RR123456789AT', 'bpost-3': 'RR123456789BE', 'bring-posten-1': 'RR123456789NO',
  'canada-post-2': 'RR123456789CA', 'china-post-1': 'RR123456789CN', 'correios-br-1': 'RR123456789BR', 'correos-chile-2': 'RR123456789CL',
  'ctt-1': 'RR123456789PT', 'hongkong-post-1': 'RR123456789HK', 'india-post-1': 'RR123456789IN',
  'japan-post-1': 'RR123456789JP', 'nz-post-1': 'RR123456789NZ', 'poczta-polska-s10': 'RR123456789PL',
  'postnord-2': 'RR123456789SE', 'thailand-post-1': 'RR123456789TH', 'usps-s10': 'RR123456789US',
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('carrier names reported by universal providers', () => {
  it('resolves a bare brand only when the number leaves one of its networks', () => {
    // DPD's depot prefix: 0606-0619 Switzerland, 10xx France (ex-Exapaq).
    expect(brandCarrierForNumber('DPD Group', '06080000000002')).toBe('dpd');
    expect(brandCarrierForNumber('dpd', '10000000000001')).toBe('dpd-fr');
    // A DPD France 250… number is its own high-confidence shape.
    expect(brandCarrierForNumber('DPD', '250000000000000')).toBe('dpd-fr');
    // DPD Poland's waybill, thirteen digits and a letter, and its 13xx depot range.
    expect(brandCarrierForNumber('DPD', '1000000000002U')).toBe('dpd-pl');
    expect(brandCarrierForNumber('DPD Group', '13000000000002')).toBe('dpd-pl');
    // Both DPD networks match and neither is preferred.
    expect(brandCarrierForNumber('DPD Group', '06200000000002')).toBeUndefined();
    // Germany and the UK share the number shape; the bare brand cannot pick a country.
    expect(brandCarrierForNumber('DPD Group', '20000000000002')).toBeUndefined();
    // The number is no network of the brand at all.
    expect(brandCarrierForNumber('GLS', '06080000000002')).toBeUndefined();
    // Not a bare brand.
    expect(brandCarrierForNumber('Swiss Post', '06080000000002')).toBeUndefined();
  });

  it('proposes one carrier only for a single, resolvable name', () => {
    expect(universalCarrierHints(['DPD Group'], '06080000000002')).toEqual({
      reported_carriers: ['DPD Group'], discovered_carrier: 'dpd',
    });
    // Without the number a brand stays a hint, as before.
    expect(universalCarrierHints(['DPD Group'])).toEqual({ reported_carriers: ['DPD Group'] });
    expect(universalCarrierHints(['DPD Group', 'DPD Group ', 7, null], '06080000000002').discovered_carrier).toBe('dpd');
    expect(universalCarrierHints(['Swiss Post', 'DPD Group'], '06080000000002')).toEqual({
      reported_carriers: ['Swiss Post', 'DPD Group'],
    });
  });

  it('keeps the postal union\'s feed among the reported names, where it proposes no carrier', () => {
    // An S10 number with a valid check digit.
    const finnish = 'RR123456785FI';
    expect(universalCarrierHints(['Finland Post'], finnish)).toEqual({ reported_carriers: ['Finland Post'], discovered_carrier: 'posti' });
    // The feed is no carrier, but it still counts as a name: two names propose nothing.
    expect(universalCarrierHints(['UPU', 'Finland Post'], finnish)).toEqual({ reported_carriers: ['UPU', 'Finland Post'] });
    expect(universalCarrierHints(['Universal Postal Union'], finnish)).toEqual({ reported_carriers: ['Universal Postal Union'] });
  });

  it('proposes no carrier whose adapter would refuse the number for its check digit', () => {
    expect(universalCarrierHints(['DHL Express'], '1234567890')).toEqual({ reported_carriers: ['DHL Express'] });
    expect(universalCarrierHints(['DHL Express'], '1234567891')).toEqual({ reported_carriers: ['DHL Express'], discovered_carrier: 'dhl-express' });
    expect(universalCarrierHints(['bpost'], 'RR123456789BE')).toEqual({ reported_carriers: ['bpost'] });
    expect(universalCarrierHints(['bpost'], 'RR123456785BE').discovered_carrier).toBe('bpost');
    // Yamato's adapter does not apply its detection rule's check, so Yamato may still know the number.
    expect(checksumRejections('123456789012').map(({ rule }) => rule)).toContain('yamato-1');
    expect(universalCarrierHints(['Yamato Transport'], '123456789012').discovered_carrier).toBe('yamato');
    // Without the number nothing is ruled out.
    expect(universalCarrierHints(['DHL Express']).discovered_carrier).toBe('dhl-express');
  });

  it('proposes no such carrier when another carrier claims the number with high confidence', async () => {
    // No catalog rule claims ten or twelve digits with high confidence yet. A
    // synthetic one hides the failed waybill and GLS France checks from the
    // suggestions and the rejections, both low-confidence, but their adapters
    // still refuse the number.
    vi.resetModules();
    vi.doMock('../../core/catalog/definitions.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../core/catalog/definitions.js')>();
      const packeta = actual.CARRIER_DEFINITIONS.packeta;
      return { ...actual, CARRIER_DEFINITIONS: { ...actual.CARRIER_DEFINITIONS, packeta: {
        ...packeta, detectionRules: [...packeta.detectionRules, { pattern: '^(?:\\d{10}|\\d{12})$', confidence: 'high' }],
      } } };
    });
    try {
      const detection = await import('../../core/detection/index.js');
      const { universalCarrierHints: hints } = await import('./hints.js');
      for (const [name, rule] of [['DHL Express', 'dhl-express-waybill'], ['GLS France', 'gls-fr-4']] as const) {
        const number = FAILING[rule]!;
        expect(detection.detectCarrierMatch(number)).toMatchObject({ carrier: 'packeta', confidence: 'high' });
        expect(detection.checksumRejections(number)).toEqual([]);
        expect(hints([name], number)).toEqual({ reported_carriers: [name] });
      }
      expect(hints(['DHL Express'], '1234567891').discovered_carrier).toBe('dhl-express');
    } finally {
      vi.doUnmock('../../core/catalog/definitions.js');
      vi.resetModules();
    }
  });

  it('holds a failing number for every adapter-checked rule', () => {
    expect(Object.keys(FAILING).sort()).toEqual([...ADAPTER_CHECKED_RULES].sort());
  });

  it.each(Object.entries(FAILING))('has %s refused by its carrier\'s adapter before any request', async (rule, number) => {
    const rejection = checksumRejections(number).find((item) => item.rule === rule);
    expect(rejection).toBeDefined();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const registry = new AdapterRegistry(REGISTRY, { fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    const adapter = registry.for(rejection!.carrier)!;
    // Some adapters refuse synchronously, before returning a promise.
    const error = await (async () => adapter.track({ number, postcode: null }, { budgetMs: 2_000 }))().catch((caught: unknown) => caught);
    expect(carrierErrorKind(error)).toBe('invalid_input');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

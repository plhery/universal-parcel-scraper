import { describe, expect, it } from 'vitest';
import { DETECTION_RULE_IDS } from '../../generated/catalog.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { recognitionAskedCarriers } from '../catalog/recognition.js';
import { checksumFailures } from './detect.js';
import {
  checksumRejections,
  detectCarrier,
  detectCarrierMatch,
  formatTrackingNumber,
  isValidDpdParcelNumber,
  isValidGlsParcelNumber,
  isValidHermesParcelNumber,
  isValidMondialRelayBarcode,
  isValidS10TrackingNumber,
  normalizeTrackingNumber,
  parseTrackingInput,
  supportsSwissPostHandoff,
  validTrackingNumber,
} from './index.js';

/**
 * The per-carrier number expectations live in src/lib/carriers.test.ts until
 * the corpus sweep replaces them. What this file pins down is the engine
 * itself, and in particular the one behaviour that had two implementations
 * before the move: the server copy of the S10 check skipped normalization.
 */
describe('S10, with one implementation for the client and the server', () => {
  it('agrees with the former server implementation on already-normalized input', () => {
    expect(isValidS10TrackingNumber('RA123456785CH')).toBe(true);
    expect(isValidS10TrackingNumber('RA123456789CH')).toBe(false);
    expect(isValidS10TrackingNumber('RA12345678CH')).toBe(false);
    expect(supportsSwissPostHandoff('LW230226618CH')).toBe(true);
    expect(supportsSwissPostHandoff('LW230226619CH')).toBe(false);
    expect(supportsSwissPostHandoff('RR230226618CH')).toBe(false);
  });

  it('now also accepts the printed spelling the server copy used to reject', () => {
    expect(isValidS10TrackingNumber('ra 123.456-785 ch')).toBe(true);
    expect(supportsSwissPostHandoff('lw 230 226 618 ch')).toBe(true);
  });
});

describe('Chronopost numbers with an S10 check digit', () => {
  it.each(['XR123456785TS', 'XT123456785TS', 'XT123456785FR', 'XR123456785DE'])('selects Chronopost for %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chronopost', confidence: 'high', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('keeps a mistyped number a Chronopost suggestion rather than international mail', () => {
    expect(detectCarrierMatch('XT123456789TS')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers('XT123456789TS')).toEqual(['chronopost']);
  });

  it.each(['RR123456785TS', 'RR123456785JF', 'RR123456785JB', 'NP123456789JB', 'HL123456789JF'])(
    'selects Chronopost for %s, whose suffix is its own rather than a country',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chronopost', confidence: 'high', candidates: ['chronopost'] });
      expect(recognitionAskedCarriers(number)).toEqual([]);
      expect(checksumRejections(number)).toEqual([]);
    },
  );

  it.each(['RR123456785RV', 'RR123456785VF'])('asks Chronopost about %s, a rarer suffix of its own', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers(number)).toEqual(['chronopost']);
    expect(checksumRejections(number)).toEqual([]);
  });
});

describe('normalization', () => {
  it('uppercases and strips the separators carriers print', () => {
    expect(normalizeTrackingNumber(' ra 123 456-789 ch ')).toBe('RA123456789CH');
    expect(formatTrackingNumber('993412345612345678')).toBe('99.34.123456.12345678');
  });

  it('reads an SSCC printed behind its bracketed GS1 identifier', () => {
    expect(normalizeTrackingNumber('(00) 3 7012345 678901234 7')).toBe('00370123456789012347');
    expect(validTrackingNumber('(00) 3 7012345 678901234 7')).toBe(true);
    expect(detectCarrierMatch('(00) 3 7012345 678901234 7')).toEqual(detectCarrierMatch('00370123456789012347'));
    expect(parseTrackingInput('(00) 370123456789012347')).toMatchObject({ source: 'number', candidates: detectCarrierMatch('00370123456789012347').candidates });
  });

  it('leaves other bracketed GS1 identifiers as typed', () => {
    // (420) carries the destination ZIP, which is no parcel number.
    for (const raw of ['(420) 12345', '(420) 12345 (92) 612 90 100 13043 50825 07', '(00) 37012345678901234', '(01) 09501101530003']) {
      expect(normalizeTrackingNumber(raw)).toContain('(');
      expect(validTrackingNumber(raw)).toBe(false);
      expect(detectCarrierMatch(raw).confidence).toBe('none');
    }
  });
});

describe('the detection engine', () => {
  it('selects a carrier only when exactly one rule claims high confidence', () => {
    expect(detectCarrier('RA123456785CH')).toBe('swiss-post');
    expect(detectCarrierMatch('RA123456785CH')).toMatchObject({ carrier: 'swiss-post', confidence: 'high' });
    expect(detectCarrierMatch('')).toEqual({ carrier: 'unknown', confidence: 'none', candidates: [], preferred: [] });
  });

  it('rejects a number whose declared checksum does not verify', () => {
    expect(detectCarrier('RA123456789CH')).toBe('unknown');
    expect(isValidMondialRelayBarcode('12123456780101006623123454')).toBe(true);
    expect(isValidMondialRelayBarcode('12123456780101006623123455')).toBe(false);
  });

  it('checks the Hermes digit before offering Hermes for a 14-digit number', () => {
    expect(isValidHermesParcelNumber('12345678901231')).toBe(true);
    expect(isValidHermesParcelNumber('12345678901234')).toBe(false);
    expect(isValidHermesParcelNumber('1234567890123')).toBe(false);
    expect(detectCarrierMatch('12345678901231').candidates).toContain('hermes-de');
    expect(detectCarrierMatch('12345678901234').candidates).not.toContain('hermes-de');
  });

  it('offers GLS for a 12-digit number only when its check digit passes', () => {
    // 11 digits, weights 3-1 from the right plus one: 12345678901 → 1.
    expect(isValidGlsParcelNumber('123456789011')).toBe(true);
    expect(isValidGlsParcelNumber('123456789012')).toBe(false);
    expect(isValidGlsParcelNumber('12345678901')).toBe(false);
    expect(detectCarrierMatch('123456789011').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de', 'gls-fr']));
    expect(detectCarrierMatch('123456789012').candidates).not.toContain('gls-de');
    // 11 digits are the same parcel number without its check digit.
    expect(detectCarrierMatch('12345678901').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de', 'gls-fr']));
  });

  it('keeps GLS to its 11- and 12-digit parcel numbers', () => {
    expect(detectCarrierMatch('123456789011').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de']));
    expect(detectCarrierMatch('1234567890123').candidates).not.toEqual(expect.arrayContaining(['gls-ch']));
    expect(detectCarrierMatch('12345678901234').candidates).not.toEqual(expect.arrayContaining(['gls-de']));
  });

  it('lists the carrier a depot prefix points to first, without selecting it', () => {
    // DPD numbers start with the depot that printed the label: 0606-0619 is
    // DPD Switzerland, 10xx DPD France. Other 14-digit carriers stay candidates.
    expect(detectCarrierMatch('06080000000002')).toMatchObject({
      carrier: 'unknown', confidence: 'low', preferred: ['dpd'],
      candidates: ['dpd', 'dpd-fr', 'relais-colis', 'ciblex', 'seur', 'brt', 'delhivery', 'dhl-ecommerce-uk', 'dpd-de', 'dpd-uk'],
    });
    expect(detectCarrierMatch('10000000000001')).toMatchObject({
      carrier: 'unknown', confidence: 'low', preferred: ['dpd-fr'],
    });
    expect(detectCarrierMatch('10000000000001').candidates[0]).toBe('dpd-fr');
    // An Austrian depot (0620+) is still a DPD shape, but without the preference.
    expect(detectCarrierMatch('06200000000002')).toMatchObject({ confidence: 'low', preferred: [] });
  });

  it('reads a number out of a pasted carrier link', () => {
    expect(parseTrackingInput('https://service.post.ch/ekp-web/ui/entry/search/RA123456785CH'))
      .toMatchObject({ trackingNumber: 'RA123456785CH', carrier: 'swiss-post', source: 'link' });
  });

  it.each(['PH000000000001', 'SPXPH000000000001'])(
    'reads the SPX Philippines portal bare query: %s', (number) => {
      expect(parseTrackingInput(`https://spx.ph/track?${number}`)).toMatchObject({
        trackingNumber: number, carrier: 'spx-ph', confidence: 'high', source: 'link',
      });
    },
  );

  it('decodes an SPX bare query without admitting another path, host or query syntax', () => {
    expect(parseTrackingInput('https://spx.ph/track?%50%48000000000001')).toMatchObject({
      trackingNumber: 'PH000000000001', carrier: 'spx-ph', source: 'link',
    });
    for (const url of [
      'https://spx.ph/other?PH000000000001',
      'https://spx.ph.example.com/track?PH000000000001',
      'https://spx.ph/track?unknown=PH000000000001',
      'https://spx.ph/track?PH000000000001&PH000000000002',
      'https://spx.ph/track?PH000000000001%2CPH000000000002',
    ]) {
      expect(parseTrackingInput(url).carrier).not.toBe('spx-ph');
    }
  });

  it('binds Nova Poshta through the current official tracking path', () => {
    expect(parseTrackingInput('https://novaposhta.ua/en/tracking/59000000000001/')).toMatchObject({
      trackingNumber: '59000000000001', carrier: 'nova-poshta', confidence: 'high', source: 'link',
    });
  });

  it.each(['87001234567890', '870012345678049'])('selects La Poste for numeric tracked mail: %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'la-poste', confidence: 'high' });
    expect(parseTrackingInput(`Suivi : ${number}`)).toMatchObject({
      trackingNumber: number, carrier: 'la-poste', confidence: 'high', source: 'text',
    });
    expect(parseTrackingInput(`https://www.laposte.fr/outils/suivre-vos-envois?code=${number}`))
      .toMatchObject({ trackingNumber: number, carrier: 'la-poste', source: 'link' });
  });

  it.each([
    'Tracking number: 12345678901',
    'Tracking number 12345678901',
    'Your tracking number is 12345678901.',
    'tracking no. 12345678901',
    'Tracking ID: 12345678901',
    'Tracking: 12345678901',
    'track 12345678901',
    'Parcel number: 12345678901',
    'Shipment tracking number: 12345678901',
    'Tracking update. Your parcel number 12345678901 leaves today',
  ])('reads the number a label introduces: %s', (text) => {
    expect(parseTrackingInput(text)).toMatchObject({ trackingNumber: '12345678901', source: 'text', confidence: 'low' });
  });

  it('keeps a label word attached to the number, and takes no word for a number', () => {
    expect(parseTrackingInput('Tracking NO123456789').trackingNumber).toBe('NO123456789');
    expect(parseTrackingInput('tracking notable1234').trackingNumber).toBe('notable1234');
    expect(parseTrackingInput('Tracking number: pending').source).toBe('none');
    expect(parseTrackingInput('Shipment tracking: delayed').source).toBe('none');
  });

  it('keeps other numeric carriers ambiguous', () => {
    expect(detectCarrierMatch('123456789012345')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('87979.0061660090')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('06080000000002').candidates[0]).toBe('dpd');
  });

  it('recognizes the PostLogistics printed reference without claiming every 11-digit number', () => {
    expect(parseTrackingInput('12345678-001')).toMatchObject({
      trackingNumber: '12345678-001', carrier: 'postlogistics', confidence: 'high', source: 'number',
    });
    expect(detectCarrier('12345678001')).not.toBe('postlogistics');
    expect(parseTrackingInput('https://tracking.postlogistics.ch/public/trackandtrace/12345678-001'))
      .toMatchObject({ trackingNumber: '12345678-001', carrier: 'postlogistics', source: 'link' });
    expect(formatTrackingNumber('12345678001', 'postlogistics')).toBe('12345678-001');
    expect(formatTrackingNumber('12345678001')).toBe('12345678001');
  });

  it('suggests Swiss Post Cargo for a PL reference, printed or compact, and asks it to confirm', () => {
    for (const number of ['PL-12345678', 'pl12345678']) {
      expect(parseTrackingInput(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['swiss-post-cargo'] });
      expect(recognitionAskedCarriers(number)).toEqual(['swiss-post-cargo']);
    }
    for (const number of ['PL-1234567', 'PL-123456789', 'PX-12345678']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('swiss-post-cargo');
    }
  });

  it('reads Swiss Post Cargo links from both tracker hosts, keeping a reference as printed', () => {
    for (const host of ['apv', 'tt']) {
      expect(parseTrackingInput(`https://${host}.swisspost-cargo.com/public/trackandtrace/AB-12345678`))
        .toMatchObject({ trackingNumber: 'AB-12345678', carrier: 'swiss-post-cargo', confidence: 'high', source: 'link' });
    }
  });
});

describe('carrier links limited to some pages of their host', () => {
  // Each page form the rule reads, ending in its number parameter, and another page of the host.
  it.each([
    ['brt', '99000000000002', [
      'https://vas.brt.it/vas/sped_det_new.htm?lang=en&brtCode=',
      'https://vas.brt.it/vas/sped_det_show.htm?brtCode=',
    ], 'https://vas.brt.it/vas/orm_det_show.htm?brtCode='],
    ['seur', '9900002', [
      'https://www.seur.com/miseur/mis-envios?tracking=',
      'https://www.seur.com/miseur/mis-envios/detalle?tracking=',
      'https://seur.com/en/miseur/mis-envios?tracking=',
    ], 'https://www.seur.com/envio-online/?tracking='],
    ['tipsa', '0990010990010000000017', [
      'https://www.tip-sa.com/cliente/datos_env.php?id=',
      'https://aplicaciones.tip-sa.com/cliente/datos.php?id=',
      'https://www.tip-sa.com/cliente/datos_prestashop.php?id=',
    ], 'https://www.tip-sa.com/contacto.php?id='],
    ['nacex', '9900/99000002', [
      'https://www.nacex.es/seguimientoFormularioExterno.do?intcli=',
      'https://nacex.es/seguimientoFormularioExterno.do;jsessionid=TEST?intcli=',
    ], 'https://www.nacex.es/irCerca.do?intcli='],
    ['estafeta', '9000000001', [
      'https://cs.estafeta.com/es/Tracking/searchByGet?isShipmentDetail=True&wayBill=',
      'https://cs.estafeta.com/en/Tracking/searchByGet/?wayBill=',
    ], 'https://cs.estafeta.com/es/Tracking/GetTrackingItemHistory?wayBill='],
    ['the-courier-guy', 'TESTA1', [
      'https://portal.thecourierguy.co.za/track?ref=',
      'https://track.thecourierguy.co.za/?ref=',
      'https://track.thecourierguy.co.za/track/?ref=',
    ], 'https://portal.thecourierguy.co.za/request-invoice?ref='],
  ])('%s', (carrier, number, pages, other) => {
    // A reference detection alone does not recognize shows that the rule read it.
    for (const page of pages) {
      for (const reference of [number, 'TESTA1']) {
        expect(parseTrackingInput(`${page}${reference}`)).toMatchObject({
          trackingNumber: reference, carrier, confidence: 'high', source: 'link',
        });
      }
    }
    const { pathname, search } = new URL(`${other}TESTA1`);
    expect(parseTrackingInput(`${other}TESTA1`)).toEqual(parseTrackingInput(`https://example.test${pathname}${search}`));
    expect(parseTrackingInput(`${other}TESTA1`).carrier).not.toBe(carrier);
  });
});

describe('checksum rejections', () => {
  it('names the rule whose failed checksum kept its carrier out of the suggestions', () => {
    expect(checksumRejections('1234567890')).toEqual([{ carrier: 'dhl-express', rule: 'dhl-express-waybill', checksum: 'dhl-express' }]);
    expect(checksumRejections('1 234 567-890')).toEqual(checksumRejections('1234567890'));
    expect(checksumRejections('1234567891')).toEqual([]);
    expect(checksumRejections('RA123456789CH')).toContainEqual({ carrier: 'swiss-post', rule: 'swiss-post-1', checksum: 's10' });
    expect(checksumRejections('RA123456785CH')).toEqual([]);
    expect(checksumRejections('')).toEqual([]);
  });

  it('judges each number on its own check digit', () => {
    // The same 12 digits fail Yamato's mod 7 with one last digit and FedEx's check with the next.
    expect(checksumRejections('123456789012').map(({ rule }) => rule)).toContain('yamato-1');
    expect(checksumRejections('123456789012').map(({ carrier }) => carrier)).not.toContain('fedex');
    expect(checksumRejections('123456789013').map(({ rule }) => rule)).toContain('fedex-1');
    expect(checksumRejections('123456789013').map(({ carrier }) => carrier)).not.toContain('yamato');
    for (const number of ['1234567890', '123456789012', '123456789013', '123456789012345']) {
      const { candidates } = detectCarrierMatch(number);
      expect(checksumRejections(number).filter(({ carrier }) => candidates.includes(carrier))).toEqual([]);
    }
  });

  it('leaves out a carrier that another of its rules still suggests', () => {
    // A failed UPS check keeps UPS among the suggestions through its shape-only rule.
    expect(detectCarrierMatch('1Z999AA10123456785').candidates).toEqual(['ups']);
    expect(checksumRejections('1Z999AA10123456785')).toEqual([]);
  });

  it('leaves out a low-confidence rule that a high-confidence match would hide even if it passed', () => {
    expect(checksumRejections('123456789012345')).toContainEqual({ carrier: 'dpd', rule: 'dpd-3', checksum: 'dpd' });
    // DPD France's 250 range selects DPD France, which hides DPD's suggestion whatever its check says.
    expect(isValidDpdParcelNumber('250123456789010')).toBe(false);
    expect(detectCarrierMatch('250123456789010')).toMatchObject({ carrier: 'dpd-fr', confidence: 'high' });
    expect(checksumRejections('250123456789010')).toEqual([]);
  });

  it('lists every failed check, including those another carrier\'s match hides', () => {
    // For the callers whose carrier's adapter applies the check itself.
    expect(checksumFailures('250123456789010')).toContainEqual({ carrier: 'dpd', rule: 'dpd-3', checksum: 'dpd' });
    expect(checksumFailures('1 234 567-890')).toEqual(checksumRejections('1234567890'));
    expect(checksumFailures('1234567891')).toEqual([]);
    expect(checksumFailures('')).toEqual([]);
    for (const number of ['1234567890', '123456789012', '123456789013', '123456789012345', '250123456789010', 'RA123456789CH']) {
      expect(checksumFailures(number)).toEqual(expect.arrayContaining(checksumRejections(number)));
    }
  });

  it('has one id for each catalog rule', () => {
    for (const [carrier, definition] of Object.entries(CARRIER_DEFINITIONS)) {
      expect(DETECTION_RULE_IDS[carrier as keyof typeof DETECTION_RULE_IDS]).toHaveLength(definition.detectionRules.length);
    }
  });
});

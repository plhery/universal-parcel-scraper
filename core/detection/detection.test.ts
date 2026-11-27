import { describe, expect, it } from 'vitest';
import { DETECTION_RULE_IDS } from '../../generated/catalog.js';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { recognitionAskedCarriers } from '../catalog/recognition.js';
import { checksumFailures } from './detect.js';
import {
  checksumRejections,
  detectCarrier,
  detectCarrierMatch,
  followsTaxLabel,
  formatTrackingNumber,
  isValidDpdParcelNumber,
  isValidGlsParcelNumber,
  isValidHermesParcelNumber,
  isValidMondialRelayBarcode,
  isValidS10TrackingNumber,
  keywordNumberInText,
  normalizeTrackingNumber,
  parseTrackingInput,
  recognizedNumberInText,
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
    expect(isValidS10TrackingNumber('RA999999987CH')).toBe(true);
    expect(isValidS10TrackingNumber('RA999999989CH')).toBe(false);
    expect(isValidS10TrackingNumber('RA99999998CH')).toBe(false);
    expect(supportsSwissPostHandoff('LW230226618CH')).toBe(true);
    expect(supportsSwissPostHandoff('LW230226619CH')).toBe(false);
    expect(supportsSwissPostHandoff('RR230226618CH')).toBe(false);
  });

  it('now also accepts the printed spelling the server copy used to reject', () => {
    expect(isValidS10TrackingNumber('ra 999.999-987 ch')).toBe(true);
    expect(supportsSwissPostHandoff('lw 230 226 618 ch')).toBe(true);
  });
});

describe('Chronopost numbers with an S10 check digit', () => {
  it.each(['XR999999987TS', 'XT999999987TS', 'XT999999987FR', 'XR999999987DE'])('selects Chronopost for %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chronopost', confidence: 'high', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('keeps a mistyped number a Chronopost suggestion rather than international mail', () => {
    expect(detectCarrierMatch('XT999999989TS')).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers('XT999999989TS')).toEqual(['chronopost']);
  });

  it.each(['RR999999987TS', 'RR999999987JF', 'RR999999987JB', 'NP999999980JB', 'HL123456789JF'])(
    'selects Chronopost for %s, whose suffix is its own rather than a country',
    (number) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chronopost', confidence: 'high', candidates: ['chronopost'] });
      expect(recognitionAskedCarriers(number)).toEqual([]);
      expect(checksumRejections(number)).toEqual([]);
    },
  );

  it.each(['RR999999987RV', 'RR999999987VF'])('asks Chronopost about %s, a rarer suffix of its own', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['chronopost'] });
    expect(recognitionAskedCarriers(number)).toEqual(['chronopost']);
    expect(checksumRejections(number)).toEqual([]);
  });
});

describe('Taiwanese S10 items', () => {
  it.each(['CP123456785TW', 'EE123456785TW', 'FT123456785TW', 'FZ123456785TW', 'LX123456785TW', 'RR123456785TW'])('names Chunghwa Post, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'chunghwa-post', confidence: 'high', candidates: ['chunghwa-post'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves letter post, which its tracker does not follow online, to international mail', () => {
    for (const number of ['UA123456785TW', 'UH123456785TW', 'UX123456785TW']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    }
    expect(detectCarrierMatch('UH123456785CN').candidates).not.toContain('chunghwa-post');
  });

  it('names nobody for a failed check digit', () => {
    expect(detectCarrierMatch('LX123456780TW').candidates).not.toContain('chunghwa-post');
  });
});

describe('Australian S10 items', () => {
  it.each(['CF123456785AU', 'EY123456785AU', 'LH123456785AU'])('names Australia Post, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'australia-post', confidence: 'high', candidates: ['australia-post'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves registered and letter-post items to international mail, asking Australia Post first', () => {
    for (const number of ['RR123456785AU', 'UH123456785AU']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
      expect(recognitionAskedCarriers(number)[0], number).toBe('australia-post');
    }
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('EY123456780AU').candidates).not.toContain('australia-post');
    expect(detectCarrierMatch('EY123456785NZ').candidates).not.toContain('australia-post');
  });
});

describe('Slovak S10 items', () => {
  it.each(['CP123456785SK', 'EE123456785SK', 'LK123456785SK', 'RR123456785SK'])('names Slovenská pošta, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'slovenska-posta', confidence: 'high', candidates: ['slovenska-posta'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    expect(detectCarrierMatch('UH123456785SK')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('UH123456785SK')[0]).toBe('slovenska-posta');
  });

  it('names nobody for a failed check digit', () => {
    expect(detectCarrierMatch('LK123456780SK').candidates).not.toContain('slovenska-posta');
  });
});

describe('Croatian S10 items', () => {
  it.each(['CP123456785HR', 'EE123456785HR', 'LW123456785HR', 'RR123456785HR'])('names Hrvatska pošta, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'hrvatska-posta', confidence: 'high', candidates: ['hrvatska-posta'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    for (const number of ['UH123456785HR', 'VV123456785HR']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
      expect(recognitionAskedCarriers(number)[0], number).toBe('hrvatska-posta');
    }
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('CP123456780HR').candidates).not.toContain('hrvatska-posta');
    expect(detectCarrierMatch('CP123456785HU').candidates).not.toContain('hrvatska-posta');
  });
});

describe('UAE S10 items', () => {
  it.each(['CP123456785AE', 'EE123456785AE', 'LW123456785AE', 'RR123456785AE'])('names Emirates Post, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'emirates-post', confidence: 'high', candidates: ['emirates-post'] });
  });

  it('leaves its other items to international mail', () => {
    expect(detectCarrierMatch('UA123456785AE')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('CP123456780AE').candidates).not.toContain('emirates-post');
    expect(detectCarrierMatch('CP123456785AT').candidates).not.toContain('emirates-post');
  });
});

describe('Polish S10 items', () => {
  it.each(['CP123456785PL', 'EE123456785PL', 'LX123456785PL', 'RR123456785PL'])('names Poczta Polska, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'poczta-polska', confidence: 'high', candidates: ['poczta-polska'] });
  });

  it.each(['VV123456785PL', 'CV123456785PL'])('leaves %s to international mail', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('LX123456784PL').candidates).not.toContain('poczta-polska');
    expect(detectCarrierMatch('LX123456785CZ').candidates).not.toContain('poczta-polska');
  });
});

describe('Estonian S10 items', () => {
  it.each(['CC123456785EE', 'EE123456785EE', 'LL123456785EE', 'RC123456785EE'])('names Omniva, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'omniva', confidence: 'high', candidates: ['omniva'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  // Meest gives these series for parcels to Ukraine, and Omniva's tracker has answered none of them.
  it.each(['RO123456785EE', 'CR123456785EE', 'CV123456785EE', 'UA123456785EE'])('leaves %s to international mail and asks Omniva about it', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers(number)[0]).toBe('omniva');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('RC123456784EE').candidates).not.toContain('omniva');
    expect(detectCarrierMatch('RC123456785LT').candidates).not.toContain('omniva');
  });
});

describe('Slovenian S10 items', () => {
  it.each(['CA123456785SI', 'EE123456785SI', 'LZ123456785SI', 'RA123456785SI'])('names Pošta Slovenije, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'posta-slovenije', confidence: 'high', candidates: ['posta-slovenije'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    expect(detectCarrierMatch('UA123456785SI')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('UA123456785SI')[0]).toBe('posta-slovenije');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('RA123456784SI').candidates).not.toContain('posta-slovenije');
    expect(detectCarrierMatch('RA123456785SK').candidates).not.toContain('posta-slovenije');
  });
});

describe('Serbian S10 items', () => {
  it.each(['CE123456785RS', 'ED123456785RS', 'LX123456785RS', 'RR123456785RS'])('names Pošta Srbije, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'posta-srbije', confidence: 'high', candidates: ['posta-srbije'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  // M-ONE gives its parcels P series numbers with the same code.
  it('leaves its other items to international mail and asks it first, then M-ONE', () => {
    expect(detectCarrierMatch('PL123456785RS')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('PL123456785RS')[0]).toBe('posta-srbije');
    expect(recognitionAskedCarriers('PL123456785RS')).toContain('m-one');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('RR123456784RS').candidates).not.toContain('posta-srbije');
    expect(detectCarrierMatch('RR123456785RU').candidates).not.toContain('posta-srbije');
  });
});

describe('Ukrainian S10 items', () => {
  it.each(['CR123456785UA', 'EE123456785UA', 'LZ123456785UA', 'RB123456785UA'])('names Ukrposhta, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'ukrposhta', confidence: 'high', candidates: ['ukrposhta'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it first', () => {
    expect(detectCarrierMatch('UA123456785UA')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('UA123456785UA')[0]).toBe('ukrposhta');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('CR123456784UA').candidates).not.toContain('ukrposhta');
    expect(detectCarrierMatch('CR123456785RU').candidates).not.toContain('ukrposhta');
  });
});

describe('Russian S10 items', () => {
  it.each(['RA123456785RU', 'LS200000010RU', 'EA300000026RU', 'CR400000032RU'])('names Russian Post, which tracks %s abroad', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'russian-post', confidence: 'high', candidates: ['russian-post'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail', () => {
    expect(detectCarrierMatch('UA500000049RU')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
  });

  it('names nobody for a failed check digit', () => {
    expect(detectCarrierMatch('RA123456784RU').candidates ?? []).not.toContain('russian-post');
  });
});

describe('Italian S10 items', () => {
  it.each(['CE999999987IT', 'CP123456785IT', 'EE999999987IT', 'LC999999987IT', 'RN999999987IT'])('names Poste Italiane, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'poste-italiane', confidence: 'high', candidates: ['poste-italiane'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    for (const number of ['KK999999987IT', 'UB999999987IT']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
      expect(recognitionAskedCarriers(number)[0], number).toBe('poste-italiane');
    }
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('CP123456780IT').candidates).not.toContain('poste-italiane');
    expect(detectCarrierMatch('CP123456785IL').candidates).not.toContain('poste-italiane');
  });
});

describe('Latvian S10 items', () => {
  it.each(['CC123456785LV', 'EE123456785LV', 'LY123456785LV', 'RR123456785LV'])('names Latvijas Pasts, which tracks %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'latvijas-pasts', confidence: 'high', candidates: ['latvijas-pasts'] });
    expect(recognitionAskedCarriers(number)).toEqual([]);
  });

  it('leaves its other items to international mail and asks it about them', () => {
    expect(detectCarrierMatch('UH123456785LV')).toMatchObject({ carrier: 'intl-post', confidence: 'high', candidates: ['intl-post'] });
    expect(recognitionAskedCarriers('UH123456785LV')[0]).toBe('latvijas-pasts');
  });

  it('names nobody for a failed check digit or another issuer', () => {
    expect(detectCarrierMatch('RR123456780LV').candidates).not.toContain('latvijas-pasts');
    expect(detectCarrierMatch('RR123456785LT').candidates).not.toContain('latvijas-pasts');
  });
});

describe('Deutsche Post Frankier-IDs', () => {
  it.each(['A0999999986ABCDEF01F', 'A000000000000000000A'])('names DHL, whose letter tracking answers %s', (number) => {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'dhl', confidence: 'high', candidates: ['dhl'] });
    expect(detectCarrierMatch(number.toLowerCase())).toMatchObject({ carrier: 'dhl', confidence: 'high' });
  });

  it('names nobody for a failed check character, another order mark or a number without letters', () => {
    for (const number of ['A0999999986ABCDEF010', 'A0999999986ABCDEF01G', 'B0999999986ABCDEF01F', 'A0999999986ABCDEF01', '00123456789012345670']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('dhl');
    }
    expect(checksumFailures('A0999999986ABCDEF010')).toContainEqual(expect.objectContaining({ carrier: 'dhl', rule: 'dhl-15' }));
  });
});

describe('normalization', () => {
  it('uppercases and strips the separators carriers print', () => {
    expect(normalizeTrackingNumber(' ra 999 999-989 ch ')).toBe('RA999999989CH');
    expect(formatTrackingNumber('993412345699999980')).toBe('99.34.123456.99999980');
  });

  it('reads an SSCC printed behind its bracketed GS1 identifier', () => {
    expect(normalizeTrackingNumber('(00) 3 7012345 678901234 7')).toBe('00370123456789012347');
    expect(validTrackingNumber('(00) 3 7012345 678901234 7')).toBe(true);
    expect(detectCarrierMatch('(00) 3 7012345 678901234 7')).toEqual(detectCarrierMatch('00370123456789012347'));
    expect(parseTrackingInput('(00) 370123456789012347')).toMatchObject({ source: 'number', candidates: detectCarrierMatch('00370123456789012347').candidates });
  });

  it('reads a number whose label prints its last digit in brackets, as PIN AG’s does', () => {
    expect(normalizeTrackingNumber('100000000000(1)')).toBe('1000000000001');
    expect(normalizeTrackingNumber('0100 1234 5678 901(2)')).toBe('0100123456789012');
    expect(parseTrackingInput('010012345678901(2)')).toMatchObject({ source: 'number', preferred: ['pin-ag'],
      candidates: detectCarrierMatch('0100123456789012').candidates });
    // A digit run too short for a parcel number, or a bracketed group of more than one digit, stays as typed.
    for (const raw of ['12345678901(2)', '123456789012(34)']) expect(validTrackingNumber(raw)).toBe(false);
  });

  it('reads a letter O typed in an S10 serial as the zero its check digit asks for', () => {
    expect(normalizeTrackingNumber('cio 0000000 5nl')).toBe('CI000000005NL');
    expect(detectCarrierMatch('CIO00000005NL')).toEqual(detectCarrierMatch('CI000000005NL'));
    expect(detectCarrierMatch('CIO00000005NL').confidence).not.toBe('none');
    // A serial whose check digit fails either way stays as typed.
    expect(normalizeTrackingNumber('CIO00000001NL')).toBe('CIO00000001NL');
  });

  it('reads a letter O typed after JD as the zero of a DHL Express piece', () => {
    for (const typed of ['jdo 146 12345678901234', 'JJDO14612345678901234', 'JDO14612345678901234J']) {
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'dhl-express', confidence: 'high' });
    }
    expect(normalizeTrackingNumber('jdo 146 12345678901234')).toBe('JD014612345678901234');
    // Only the piece's own length and range: anything else stays as typed.
    for (const typed of ['JDO24612345678901234', 'JDO1461234567890123', 'JDOA4612345678901234']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('reads a letter O typed after JRT as a stray letter in a JRT number', () => {
    for (const typed of ['jrto 0000000001 mm', 'JRTO0000000001MM']) {
      expect(normalizeTrackingNumber(typed), typed).toBe('JRT0000000001MM');
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'jrt', confidence: 'high' });
    }
    // A letter O among the ten digits is a zero typed as a letter.
    for (const typed of ['JRTOO00000001MM', 'JRTO000000001MM', 'jrt 00o0000001 mm']) {
      expect(normalizeTrackingNumber(typed), typed).toBe('JRT0000000001MM');
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'jrt', confidence: 'high' });
    }
    // Only JRT's own length and suffix: anything else stays as typed.
    for (const typed of ['JRTO00000000001MM', 'JRTO0000000001AB', 'JRTOO0000000001MM', 'JRTOO000000001AB']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('reads a letter O typed after GFUS or GFCA as the zero of a GOFO waybill', () => {
    for (const [typed, waybill, carrier] of [
      ['gfcao 1357924680135', 'GFCA01357924680135', 'gofo-ca'],
      ['GFUSO1357924680135', 'GFUS01357924680135', 'gofo'],
    ] as const) {
      expect(normalizeTrackingNumber(typed), typed).toBe(waybill);
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier, confidence: 'high' });
    }
    // Only right after the region, at the waybill's own length: anything else stays as typed.
    for (const typed of ['GFCAO135792468013', 'GFCAO13579246801351', 'GFCAOO357924680135', 'GFCA0O357924680135', 'GFUKO1357924680135']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('reads a letter O in an Allegro One AD0 number as a zero', () => {
    for (const typed of ['ado jdfz5hczx7sb3g', 'ADOJDFZ5HCZX7SB3G', 'AD0JDFZ5HCZX7SBOG', 'ADOJDFZ5HCZXOSB3G']) {
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'allegro-one', confidence: 'high' });
    }
    expect(normalizeTrackingNumber('ADOJDFZ5HCZX7SB3G')).toBe('AD0JDFZ5HCZX7SB3G');
    // Only at Allegro One's length and with its letters, which hold no other vowel: anything else stays as typed.
    for (const typed of ['ADOJDFZ5HCZX7SB3', 'ADOJDFZ5HCZX7SB3GG', 'ADOJAFZ5HCZX7SB3G', 'ACOJDFZ5HCZX7SB3G']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('reads a number pasted twice in a row once', () => {
    expect(normalizeTrackingNumber('FR5820461937 FR5820461937')).toBe('FR5820461937');
    expect(detectCarrierMatch('FR5820461937FR5820461937')).toMatchObject({ carrier: 'amazon-logistics', confidence: 'high' });
    expect(normalizeTrackingNumber('RR123456785CNRR123456785CN')).toBe('RR123456785CN');
    // Synthetic numbers. Eleven digits pasted twice fit Australia Post's 22-digit shape: only a GS1 check digit that holds keeps them whole.
    expect(normalizeTrackingNumber('03141592653 03141592653')).toBe('03141592653');
    expect(normalizeTrackingNumber('0123456789001234567890')).toBe('0123456789001234567890');
    // Two different numbers, or a repeat shorter than ten characters, stay as typed.
    for (const typed of ['FR5820461937FR4820461937', '123456789123456789', 'ABCABC', '0'.repeat(26)]) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('reads a letter O among a JS Express waybill\'s digits as a zero', () => {
    for (const typed of ['jseab 000000001o yq', 'JSEAB000000001OYQ', 'JSEABO00000001OYQ']) {
      expect(normalizeTrackingNumber(typed), typed).toBe('JSEAB0000000010YQ');
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'js-express', confidence: 'high' });
    }
    // Only between JSE's letters and YQ, at its own length: anything else stays as typed.
    for (const typed of ['JSEOB0000000001YQ', 'JSEAB00000001OYQ', 'JSEAB0000000001OYQ', 'JSEAB000000001OAB', 'FEIAB000000001OYQ']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('reads a letter O among a WanbExpress waybill\'s digits as a zero', () => {
    for (const typed of ['WNBZZO000000001YQ', 'wnbzz o00000000o yq']) {
      const waybill = typed.startsWith('W') ? 'WNBZZ0000000001YQ' : 'WNBZZ0000000000YQ';
      expect(normalizeTrackingNumber(typed), typed).toBe(waybill);
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'wanbexpress', confidence: 'high' });
    }
    // The series letters keep a letter O, and anything off WanbExpress's length stays as typed.
    for (const typed of ['WNBZO0000000001YQ', 'WNBZZO00000001YQ', 'WNBZZO0000000001YQ', 'WNBZZO000000001AB']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('reads a zero typed for a JS Express waybill\'s second letter as the letter O', () => {
    for (const [typed, waybill] of [['JSEA00000000001YQ', 'JSEAO0000000001YQ'], ['jsea0 000000001o yq', 'JSEAO0000000010YQ']] as const) {
      expect(normalizeTrackingNumber(typed), typed).toBe(waybill);
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'js-express', confidence: 'high' });
    }
    // Only a zero in that place, after one letter and before ten digits: other digits and lengths stay as typed.
    for (const typed of ['JSEA10000000001YQ', 'JSEA0000000001YQ', 'JSEA000000000001YQ', 'JSE000000000001YQ', 'FEIA00000000001YQ']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('drops the slashes of a NO LIMIT shipment number, which reads the same without them', () => {
    for (const typed of ['P/40017/LSMP/2026', ' p/40017/lsmp/2026 ', 'P40017/LSMP/2026', 'P 40017 LSMP 2026']) {
      expect(normalizeTrackingNumber(typed), typed).toBe('P40017LSMP2026');
      expect(validTrackingNumber(typed), typed).toBe(true);
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'no-limit', confidence: 'high', candidates: ['no-limit'] });
    }
    expect(parseTrackingInput('Numer przesyłki: P/40017/LSMP/2026, dostawa jutro')).toMatchObject({ source: 'text', trackingNumber: 'P/40017/LSMP/2026', carrier: 'no-limit' });
    // Another layout keeps its slashes, and stays no number.
    for (const typed of ['P/40017/SMP/2026', 'P//LSMP/2026', 'P/40017/LSMP/1999', 'Q/40017/LSMP/2026']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
      expect(validTrackingNumber(typed), typed).toBe(false);
    }
  });

  it('drops the slash MRW prints after the office\'s five digits', () => {
    for (const [typed, number] of [['01234/A567890', '01234A567890'], [' 01234/a567890 ', '01234A567890'], ['01234/5678901', '012345678901']] as const) {
      expect(normalizeTrackingNumber(typed), typed).toBe(number);
      expect(validTrackingNumber(typed), typed).toBe(true);
      expect(detectCarrierMatch(typed).candidates, typed).toContain('mrw');
    }
    expect(detectCarrierMatch('01234/A567890')).toMatchObject({ carrier: 'mrw', confidence: 'high' });
    expect(parseTrackingInput('Nº Etiqueta 01234/A567890, entrega mañana')).toMatchObject({ source: 'text', carrier: 'mrw' });
    // Other splits keep their slash: NACEX's four and eight digits, and no other layout is a number.
    expect(normalizeTrackingNumber('1234/56789012')).toBe('1234/56789012');
    for (const typed of ['0123/4A567890', '012345/A56789', '01234/AA67890', '01234/A5678901']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
      expect(validTrackingNumber(typed), typed).toBe(false);
    }
  });

  it('accepts one underscore inside a number, as Better Trucks writes its BTS_ numbers', () => {
    expect(normalizeTrackingNumber(' bts_0123smpl002 ')).toBe('BTS_0123SMPL002');
    expect(validTrackingNumber(' bts_0123smpl002 ')).toBe(true);
    expect(parseTrackingInput('BTS_0123SMPL002')).toMatchObject({ source: 'number', trackingNumber: 'BTS_0123SMPL002' });
    for (const raw of ['_BTS0123SMPL002', 'BTS0123SMPL002_', 'BTS__0123SMPL002', 'BTS_0123_SMPL002', 'BTS_SMPL']) {
      expect(validTrackingNumber(raw), raw).toBe(false);
    }
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
    expect(detectCarrier('RA999999987CH')).toBe('swiss-post');
    expect(detectCarrierMatch('RA999999987CH')).toMatchObject({ carrier: 'swiss-post', confidence: 'high' });
    expect(detectCarrierMatch('')).toEqual({ carrier: 'unknown', confidence: 'none', candidates: [], preferred: [] });
  });

  it('rejects a number whose declared checksum does not verify', () => {
    expect(detectCarrier('RA999999989CH')).toBe('unknown');
    expect(isValidMondialRelayBarcode('12123999999999999999999987')).toBe(true);
    expect(isValidMondialRelayBarcode('12123999999999999999999985')).toBe(false);
  });

  it('checks the Hermes digit before offering Hermes for a 14-digit number', () => {
    expect(isValidHermesParcelNumber('12345678901231')).toBe(true);
    expect(isValidHermesParcelNumber('12345678901234')).toBe(false);
    expect(isValidHermesParcelNumber('1234567890123')).toBe(false);
    expect(detectCarrierMatch('12345678901231').candidates).toContain('hermes-de');
    expect(detectCarrierMatch('12345678901234').candidates).not.toContain('hermes-de');
  });

  it('suggests Hermes first for fourteen digits from 022 with a passing Hermes digit, wherever the parcel comes from', () => {
    for (const number of ['02200000000002', '02270000000012', '02299999999992']) {
      const detected = detectCarrierMatch(number);
      expect(detected, number).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['hermes-de'] });
      expect(detected.candidates?.[0], number).toBe('hermes-de');
      for (const countryHint of [undefined, 'DE', 'IT']) expect(recognitionAskedCarriers(number, { countryHint })[0], number).toBe('hermes-de');
    }
    for (const number of ['02200000000003', '02300000000009']) expect(detectCarrierMatch(number).preferred ?? [], number).not.toContain('hermes-de');
  });

  it('offers Hermes for a barcode starting 0 typed after another zero, and asks it first in Germany', () => {
    expect(detectCarrierMatch('001234567890128')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('001234567890128').candidates).toContain('hermes-de');
    expect(recognitionAskedCarriers('001234567890128', { countryHint: 'DE' })[0]).toBe('hermes-de');
    for (const number of ['001234567890129', '012345678901231', '0001234567890128']) {
      expect(detectCarrierMatch(number).candidates ?? [], number).not.toContain('hermes-de');
    }
  });

  it('offers GLS for a 12-digit number only when its check digit passes', () => {
    // 11 digits, weights 3-1 from the right plus one: 12345999998 → 1.
    expect(isValidGlsParcelNumber('123459999981')).toBe(true);
    expect(isValidGlsParcelNumber('123459999989')).toBe(false);
    expect(isValidGlsParcelNumber('12345999998')).toBe(false);
    expect(detectCarrierMatch('123459999981').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de', 'gls-fr']));
    expect(detectCarrierMatch('123459999989').candidates).not.toContain('gls-de');
    // 11 digits are the same parcel number without its check digit.
    expect(detectCarrierMatch('12345999998').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de', 'gls-fr']));
  });

  it('keeps GLS to its 11- and 12-digit parcel numbers', () => {
    expect(detectCarrierMatch('123459999981').candidates).toEqual(expect.arrayContaining(['gls-ch', 'gls-de']));
    expect(detectCarrierMatch('1234567890123').candidates).not.toEqual(expect.arrayContaining(['gls-ch']));
    expect(detectCarrierMatch('12345678901234').candidates).not.toEqual(expect.arrayContaining(['gls-de']));
  });

  it('lists the carrier a depot prefix points to first, without selecting it', () => {
    // DPD numbers start with the depot that printed the label: 0600-0619 is
    // DPD Switzerland, 10xx DPD France. Other 14-digit carriers stay candidates.
    expect(detectCarrierMatch('06080000000002')).toMatchObject({
      carrier: 'unknown', confidence: 'low', preferred: ['dpd'],
      candidates: ['dpd', 'dpd-fr', 'chronopost', 'ciblex', 'seur', 'brt', 'dhl-ecommerce-uk', 'dpd-be', 'dpd-de', 'dpd-hu', 'dpd-nl', 'dpd-pt', 'dpd-uk',
        'gls-nl', 'jadlog'],
    });
    // DPD Switzerland's forms ask for numbers starting with 060.
    for (const number of ['06000000000003', '06030000000002', '06190000000001']) {
      expect(detectCarrierMatch(number)).toMatchObject({ confidence: 'low', preferred: ['dpd'] });
    }
    expect(detectCarrierMatch('10009999999980')).toMatchObject({
      carrier: 'unknown', confidence: 'low', preferred: ['dpd-fr'],
    });
    expect(detectCarrierMatch('10009999999980').candidates[0]).toBe('dpd-fr');
    // DPD Austria's depot codes prefer it; a code its depot list skips stays a plain DPD shape.
    expect(detectCarrierMatch('06200000000002')).toMatchObject({ confidence: 'low', preferred: ['dpd-at'] });
    expect(detectCarrierMatch('06310000000002')).toMatchObject({ confidence: 'low', preferred: [] });
  });

  it('reads a number out of a pasted carrier link', () => {
    // Swiss Post's old and current tracking links, and the address its search box opens, name
    // Swiss Post even for an item another post numbered; other post.ch pages do not.
    for (const link of ['https://service.post.ch/ekp-web/ui/entry/search/RA123456785IR',
      'https://www.post.ch/swisspost-tracking?formattedParcelCodes=RA123456785IR&lang=de',
      'https://mys.post.ch/my-consignments/deeplink-search?formattedParcelCodes=RA123456785IR&lang=fr',
      'https://service.post.ch/ekp-web/external/view/RA123456785IR?lang=it']) {
      expect(parseTrackingInput(link), link)
        .toMatchObject({ trackingNumber: 'RA123456785IR', carrier: 'swiss-post', source: 'link' });
    }
    expect(parseTrackingInput('https://www.post.ch/de/empfangen/sendung-verfolgen?formattedParcelCodes=RA123456785IR').carrier)
      .not.toBe('swiss-post');
    // Codes a link joins with a space are several, and the first is read, as after a comma; groups printed apart stay one number.
    expect(parseTrackingInput('https://www.post.ch/swisspost-tracking?formattedParcelCodes=RA123456785IR%20RA987654326IR&lang=de'))
      .toMatchObject({ trackingNumber: 'RA123456785IR', carrier: 'swiss-post', source: 'link' });
    expect(parseTrackingInput('https://www.post.ch/swisspost-tracking?formattedParcelCodes=99.60.123456.12345678+99.60.123456.12345679')
      .trackingNumber).toBe('99.60.123456.12345678');
    expect(parseTrackingInput('https://www.post.ch/swisspost-tracking?formattedParcelCodes=99%2060%20123456%2012345678').trackingNumber)
      .toBe('99 60 123456 12345678');
  });

  it('keeps a percent escape apart from the characters after it', () => {
    // Read raw, "%3D201234567" would be WeDo's "3D201234567".
    for (const input of ['https://shop.example/help?nodeId%3D201234567',
      'https://shop.example/help?nodeId%2F201234567',
      'https://shop.example/r?u=https%3A%2F%2Fshop.example%2Fhelp%3Fx%3D1%26nodeId%3D201234567%26qid%3D9',
      'shop.example/help?nodeId%3D201234567',
      'Your parcel https://shop.example/help?tracking%3D201234567 is on its way']) {
      expect(parseTrackingInput(input), input).toMatchObject({ trackingNumber: '', carrier: 'unknown', source: 'none' });
    }
    expect(parseTrackingInput('https://shop.example/track/RA123456785IR%E0%A4%A'))
      .toMatchObject({ trackingNumber: 'RA123456785IR', source: 'text' });
  });

  it('reads the links Transpress and CVC tracking forms open', () => {
    for (const link of ['https://transpress.bg/bg/prosledjavane?track-number=123456789',
      'https://www.transpress.bg/en/prosledjavane/?track-number=123456789']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: '123456789', carrier: 'transpress', source: 'link' });
    }
    expect(parseTrackingInput('https://my.e-cvc.bg/track?wb=123456789&checkit=%D0%9F%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%B8'))
      .toMatchObject({ trackingNumber: '123456789', carrier: 'cvc', source: 'link' });
    for (const link of ['https://transpress.bg/bg/search/?track-number=123456789', 'https://my.e-cvc.bg/login?wb=123456789']) {
      expect(parseTrackingInput(link).carrier, link).not.toMatch(/^(?:transpress|cvc)$/);
    }
  });

  it('reads a GETOnline link on the shared host as SkyNet only for its own stid', () => {
    for (const link of ['https://tracking.frontierforce.com/go/plm-tracking?stid=skynet&cn=ZZ0000000000',
      'https://tracking.frontierforce.com/go/plm-tracking?cn=ZZ0000000000&stid=skynet']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'ZZ0000000000', carrier: 'skynet-worldwide', source: 'link' });
    }
    for (const link of ['https://tracking.frontierforce.com/go/plm-tracking?stid=rr&cn=1000000001',
      'https://tracking.frontierforce.com/go/plm-tracking?stid=skynetx&cn=1000000001',
      'https://tracking.frontierforce.com/go/plm-tracking?cn=1000000001']) {
      expect(parseTrackingInput(link)?.carrier, link).not.toBe('skynet-worldwide');
    }
  });

  it.each(['PH999999999980', 'SPXPH999999999980'])(
    'reads the SPX Philippines portal bare query: %s', (number) => {
      expect(parseTrackingInput(`https://spx.ph/track?${number}`)).toMatchObject({
        trackingNumber: number, carrier: 'spx-ph', confidence: 'high', source: 'link',
      });
    },
  );

  it('names SPX Express Brazil for BR and thirteen characters, from a number or its tracker links', () => {
    for (const number of ['BR250471826359A', 'BR2504718263591']) {
      expect(detectCarrierMatch(number), number).toMatchObject({ carrier: 'spx-br', confidence: 'high' });
    }
    for (const number of ['BR25047182635', 'BR250471826359AB', 'RB250471826359A']) {
      expect(detectCarrierMatch(number).candidates, number).not.toContain('spx-br');
    }
    for (const link of ['https://spx.com.br/track?BR250471826359A', 'spx.com.br/track?BR250471826359A',
      'Seu pedido: www.spx.com.br/detail/BR250471826359A.']) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: 'BR250471826359A', carrier: 'spx-br', source: 'link' });
    }
  });

  it('reads a letter O among SPX Express Brazil\'s twelve digits as a zero', () => {
    for (const [typed, number] of [['BR2613579246O8A', 'BR261357924608A'], ['br 26135792468o u', 'BR261357924680U'], ['BRO61357924680O', 'BR061357924680O']] as const) {
      expect(normalizeTrackingNumber(typed), typed).toBe(number);
      expect(detectCarrierMatch(typed), typed).toMatchObject({ carrier: 'spx-br', confidence: 'high' });
    }
    // Only between BR and the last character, at SPX's own length: anything else stays as typed.
    for (const typed of ['BR261357924680O', 'BR2613579246O8', 'BR2613579246O8AB', 'RB2613579246O8A']) {
      expect(normalizeTrackingNumber(typed), typed).toBe(typed);
    }
  });

  it('reads a link printed without its scheme only on a host a link rule names', () => {
    expect(parseTrackingInput('(spx.ph/track?PH407182635901)')).toMatchObject({
      trackingNumber: 'PH407182635901', carrier: 'spx-ph', source: 'link',
    });
    for (const text of ['example.com/track?PH407182635901', 'a@spx.ph/track?PH407182635901', 'spx.ph.example.com/track?PH407182635901']) {
      expect(parseTrackingInput(text).source, text).not.toBe('link');
    }
  });

  it('decodes an SPX bare query without admitting another path, host or query syntax', () => {
    expect(parseTrackingInput('https://spx.ph/track?%50%48999999999980')).toMatchObject({
      trackingNumber: 'PH999999999980', carrier: 'spx-ph', source: 'link',
    });
    for (const url of [
      'https://spx.ph/other?PH999999999980',
      'https://spx.ph.example.com/track?PH999999999980',
      'https://spx.ph/track?unknown=PH999999999980',
      'https://spx.ph/track?PH999999999980&PH000000000002',
      'https://spx.ph/track?PH999999999980%2CPH000000000002',
    ]) {
      expect(parseTrackingInput(url).carrier).not.toBe('spx-ph');
    }
  });

  it('reads a trans-o-flex barcode, but no shipper reference, from a guest tracker link', () => {
    for (const query of [
      'type=barcode&ref=100000000000000004900000',
      'ref=100000000000000004900000&type=barcode&zip=00000&streetno=0',
    ]) {
      expect(parseTrackingInput(`https://www.trans-o-flex.com/sendungsverfolgung/tracking?${query}`)).toMatchObject({
        trackingNumber: '100000000000000004900000', carrier: 'trans-o-flex', source: 'link',
      });
    }
    // The form trans-o-flex support quotes: eleven digits, a hyphen and thirteen.
    expect(parseTrackingInput('https://www.trans-o-flex.com/sendungsverfolgung/tracking?ref=10000000000-0000004900000&type=barcode'))
      .toMatchObject({ trackingNumber: '10000000000-0000004900000', carrier: 'trans-o-flex', source: 'link' });
    expect(parseTrackingInput('https://www.trans-o-flex.com/sendungsverfolgung/tracking?ref=ABC-0001&type=ref').carrier)
      .not.toBe('trans-o-flex');
  });

  it('binds Nova Poshta through the current official tracking path', () => {
    expect(parseTrackingInput('https://novaposhta.ua/en/tracking/59099999999980/')).toMatchObject({
      trackingNumber: '59099999999980', carrier: 'nova-poshta', confidence: 'high', source: 'link',
    });
  });

  it.each(['87099999999990', '870999999999961'])('selects La Poste for numeric tracked mail: %s', (number) => {
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

  it.each([
    'Votre numéro de suivi est le 12345678.',
    'Votre colis n°12345678 arrive demain',
    'Ihre Sendungsnummer lautet 12345678.',
    'Dein Paket mit der Sendungsnummer 12345678 kommt morgen',
    'Su número de seguimiento es 12345678',
    'Il tuo numero di tracciamento è 12345678',
    'O código de rastreio é 12345678',
    'Twój numer przesyłki: 12345678 jest w drodze',
    'Je zending 12345678 is onderweg',
  ])('reads the number a label introduces in other languages: %s', (text) => {
    expect(parseTrackingInput(text)).toMatchObject({ trackingNumber: '12345678', source: 'text', confidence: 'low' });
  });

  it('reads the number after a label that names its carrier', () => {
    // Synthetic number.
    for (const text of [
      'N° de suivi DPD : 12345678901234', 'Numéro de colis DPD : 12345678901234', 'Votre numéro de suivi DPD est le 12345678901234',
      'Suivi DPD : 12345678901234', 'Votre colis DPD n° 12345678901234', 'Numéro de colis GLS : 12345678901234',
      'Numéro de suivi Mondial Relay : 12345678901234', 'Numéro de suivi Colis Privé : 12345678901234',
      'Sendungsnummer DHL: 12345678901234', 'Tracking number UPS: 12345678901234', "Numéro d'expédition : 12345678901234",
      // Words the catalog names no carrier by leave the search to a later label.
      'Suivi de votre colis : 12345678901234', 'Numéro de suivi de votre colis : 12345678901234',
    ]) expect(keywordNumberInText(text), text).toBe('12345678901234');
    for (const text of [
      'Suivi Commande : 12345678901234', 'Numéro de colis suivant : 12345678901234', 'Votre colis Commande n° 12345678901234',
      "Frais d'expédition : 4,90 €", "Date d'expédition : 12/11/2026", "Date d'expédition : 2026-11-12", 'Expédition du 12.11.2026',
      "Adresse d'expédition : 12 rue des Lilas", "Délai d'expédition : 2 à 3 jours", 'Service colis DPD : 01 23 45 67 89',
    ]) expect(keywordNumberInText(text), text).toBeUndefined();
  });

  it("reads a number under its carrier's name only when the number fits that carrier", () => {
    // Synthetic numbers. A shop's order table prints its carrier's name above the number; an email reader can join the two with a colon.
    for (const text of ['DPD: 01234567890128', 'Transporteur DPD : 01234567890128.', 'Your order\nCarrier\nDPD\n01234567890128\n']) {
      expect(keywordNumberInText(text), text).toBe('01234567890128');
    }
    expect(keywordNumberInText('Colissimo : 6A12345678901')).toBe('6A12345678901');
    expect(parseTrackingInput('DPD: 01234567890128')).toMatchObject({ trackingNumber: '01234567890128', source: 'text', confidence: 'low' });
    expect(parseTrackingInput('DPD: 01234567890128').candidates).toContain('dpd');
    // A phone line, a name that is no carrier's, a name inside a sentence, two numbers, and a number in another carrier's shape.
    for (const text of [
      'DPD: 0800 123 456', 'DPD: 0800123456', 'UPS: 1-800-742-5877', 'Order: 01234567890128', 'Sent by DPD\n01234567890128',
      'DPD: 01234567890128 or 01234567890135', 'DPD: LX12345678',
    ]) expect(keywordNumberInText(text), text).toBeUndefined();
  });

  it("reads no tax number after its label, though it has a tracking number's shape", () => {
    // Synthetic numbers in the shape of Amazon's, a country's code and ten digits, as Belgium's, Poland's and Slovakia's VAT numbers are written.
    expect(detectCarrierMatch('BE0123456789')).toMatchObject({ carrier: 'amazon-logistics', confidence: 'high' });
    for (const text of [
      'Acme BV\nBTW: BE0123456789', 'BTW BE0123456789', 'VAT No.: BE0123456789', 'N° TVA intracommunautaire : BE0123456789',
      'BTW-nummer: BE0123456789', 'USt-IdNr.: BE0123456789', 'NIP: PL1234567890', 'IČ DPH: SK1234567890', 'DIČ: CZ1234567890', 'CUI: RO1234567890',
    ]) {
      expect(recognizedNumberInText(text), text).toBeUndefined();
      expect(parseTrackingInput(text), text).toMatchObject({ carrier: 'unknown', candidates: [] });
    }
    // The same number printed elsewhere, and another number after it, are read; a label on another line labels nothing here.
    expect(recognizedNumberInText('BTW: BE0123456789\nTracking: BE0123456789')).toBe('BE0123456789');
    expect(recognizedNumberInText('BTW: BE0123456789, your parcel PL9999999999')).toBe('PL9999999999');
    expect(followsTaxLabel('Prices incl. VAT\nBE0123456789', 17)).toBe(false);
    expect(followsTaxLabel('VAT reg. no. BE0123456789', 13)).toBe(true);
  });

  it('reads the number after a Russian or Chinese label', () => {
    for (const text of ['Трек-номер: 1234567899', 'трек номер 1234567899', 'Номер отслеживания: 1234567899', 'Номер отправления: 1234567899',
      'ШПИ: 1234567899', 'Почтовый идентификатор 1234567899', '运单号：1234567899', '快递单号: 1234567899', '物流单号 1234567899',
      '追踪号：1234567899', '運單號：1234567899', '您的运单号是 1234567899', '运单号为：1234567899']) {
      expect(keywordNumberInText(text), text).toBe('1234567899');
    }
    // An order number is no tracking number, and a word that only ends like a label is none.
    for (const text of ['订单号: 1234567899', '运单状态 1234567899', 'Автотрек-номер 1234567899']) {
      expect(keywordNumberInText(text), text).toBeUndefined();
    }
  });

  it('reads no phone number after a label, nor the number of a service line', () => {
    for (const text of ['Service colis : 01 23 45 67 89', 'Votre colis : 01.23.45.67.89', 'Service colis : 0123456789', 'Kundenservice Paket: 1234567899']) {
      expect(keywordNumberInText(text), text).toBeUndefined();
    }
    expect(keywordNumberInText('Service de suivi : 1234567899')).toBe('1234567899');
    // Synthetic numbers. A phone number ends no search: a later label's number is read.
    expect(keywordNumberInText('Votre colis : 01 23 45 67 89\nTracking number: 1234567')).toBe('1234567');
    expect(parseTrackingInput('Votre colis : 01.23.45.67.89\nTracking number: 1234567')).toMatchObject({ trackingNumber: '1234567', source: 'text' });
  });

  it('reads the groups a number prints apart in a message', () => {
    expect(parseTrackingInput('Your tracking number is 1Z 999 AA1 01 2345 6784 and it ships today'))
      .toMatchObject({ trackingNumber: '1Z999AA10123456784', carrier: 'ups', confidence: 'high', source: 'text' });
    for (const text of ['Votre colis numéro 1234 5678 9012 sera livré demain', 'Sendungsnummer 1234 5678 9012 wird morgen zugestellt.']) {
      expect(parseTrackingInput(text), text).toMatchObject({ trackingNumber: '123456789012', source: 'text' });
    }
    // A long number keeps no short one after it, and short groups that make no number are none.
    expect(parseTrackingInput('Tracking 1234567899 12 Teile').trackingNumber).toBe('1234567899');
    for (const text of ['Parcel 12 34 or so', 'Colis 123 45 euros']) expect(parseTrackingInput(text).source, text).toBe('none');
  });

  it('takes no number from a label that offers two, nor a date', () => {
    for (const text of ['Tracking number 5555666677 or 7777888899', 'Sendung 12.10.2026', 'Votre colis du 12/10/2026',
      'Tracking 1234 5678 or 9999 8888', 'Suivi colis 12 10 2026 merci',
      // Year first too, whether the label is the whole entry or starts a sentence.
      "Date d'envoi : 2026-11-12", 'Fecha de envío: 2026-11-12', 'Data di spedizione: 2026-11-12', 'Tracking: 2026-11-12',
      'Tracking: 2026/11/12', 'Tracking: 2026.11.12.', 'Tracking: 2026 11 12', 'Votre colis du 2026-11-12 arrive demain']) {
      expect(parseTrackingInput(text), text).toMatchObject({ trackingNumber: '', source: 'none' });
      expect(keywordNumberInText(text), text).toBeUndefined();
    }
    const groups = ['2026', '54', '32'];
    for (const separator of [' ', '-', '.']) {
      expect(parseTrackingInput('Tracking number ' + groups.join(separator)).trackingNumber).toBe(groups.join(separator));
    }
    expect(parseTrackingInput('Tracking number 2024 02 29').source).toBe('none');
    // A number of the same length is still read.
    expect(keywordNumberInText('Tracking: 20261112')).toBe('20261112');
  });

  it('reads no year a month and day follow, and goes on to a later label', () => {
    // Chinese text prints the date right after its label, with no space.
    for (const text of ['您的运单2026年11月12日已发货', '运单2026/11/12发货', '运单 2026 年 11 月 12 日', '运单号 2026年11月发货']) {
      expect(keywordNumberInText(text), text).toBeUndefined();
    }
    // Synthetic numbers.
    expect(parseTrackingInput('运单2026年11月12日发出 运单号：781234567890123').trackingNumber).toBe('781234567890123');
    expect(keywordNumberInText('Tracking: 2026-11-12, tracking number: 1234567899')).toBe('1234567899');
    expect(keywordNumberInText('运单号：20261112')).toBe('20261112');
  });

  it('takes no word of a message or a link for a number, though its shape fits a carrier', () => {
    expect(detectCarrierMatch('ADDITIONAL').confidence).toBe('high');
    for (const text of [
      'For additional information on the scope of this notice, please contact our customer service.',
      'Psychological additionally aseptically',
      'https://shop.example/help/additional?topic=additional',
    ]) expect(parseTrackingInput(text), text).toMatchObject({ trackingNumber: '', source: 'none' });
    // Typed alone, it is the number the visitor means, however many letters a carrier's rule takes.
    expect(parseTrackingInput('ADDITIONAL')).toMatchObject({ trackingNumber: 'ADDITIONAL', source: 'number' });
    expect(detectCarrierMatch('PSQWERTYUIOPA')).toMatchObject({ carrier: 'bulgarian-posts', confidence: 'high' });
    expect(parseTrackingInput(' PSQWERTYUIOPA ')).toMatchObject({ trackingNumber: 'PSQWERTYUIOPA', carrier: 'bulgarian-posts', source: 'number' });
    expect(parseTrackingInput('Votre colis PSQWERTYUIOPA est en route')).toMatchObject({ trackingNumber: '', source: 'none' });
    // A word beside a number leaves the number.
    expect(parseTrackingInput('For additional information track 1Z999AA10123456784').trackingNumber).toBe('1Z999AA10123456784');
  });

  it('reads the number "package" introduces as it reads one after "parcel"', () => {
    // Synthetic number in the shape of a marketplace's "arrived in your country" notice: three letters, 16 digits.
    const number = 'ABC1234567890123456';
    for (const text of [
      `Your package ${number} has arrived in your country/region.`, `Package ${number}: in your country/region`,
      `Package ${number} is out for delivery`, `Package number: ${number}`, `Package ID: ${number}`, `Package no. ${number}`,
      `Package tracking number: ${number}`, `Track your package ${number}`,
    ]) expect(keywordNumberInText(text), text).toBe(number);
    // A count, a word, a date or a weight after it is no number.
    for (const text of ['Package 1 of 2', 'Package details: 2 items', 'Your package will arrive on 2026-11-25', 'Package weight 2500 g',
      'Package 12 of 30', 'Packages: 3']) {
      expect(keywordNumberInText(text), text).toBeUndefined();
    }
  });

  it('reads the number after a separator printed twice', () => {
    expect(parseTrackingInput('Tracking Number: : 12345678901')).toMatchObject({ trackingNumber: '12345678901', source: 'text', confidence: 'low' });
  });

  it('keeps a label word attached to the number, and takes no word for a number', () => {
    expect(parseTrackingInput('Tracking NO123456789').trackingNumber).toBe('NO123456789');
    expect(parseTrackingInput('tracking notable1234').trackingNumber).toBe('notable1234');
    expect(parseTrackingInput('Tracking number: pending').source).toBe('none');
    expect(parseTrackingInput('Shipment tracking: delayed').source).toBe('none');
  });

  it.each([
    ['Abholcode 123456', '123456'],
    ['Abholcode: 123456', '123456'],
    ['Pickup code 123456', '123456'],
    ['Sendungsnummer 0034 0434 1234 5678', '0034 0434 1234 5678'],
    ['Tracking number: 0034 0434 1234 5678', '0034 0434 1234 5678'],
    ['Nr. 12345678', '12345678'],
    ['N° de suivi 12345678', '12345678'],
    ['N°12345678', '12345678'],
    ['Numéro de suivi : 12345678', '12345678'],
    ['numéro de colis 12345678', '12345678'],
    ['Suivi: 12345678', '12345678'],
    ['Trackingnummer: 12345678', '12345678'],
    ['Nº de seguimiento: 12345678', '12345678'],
    ['número de envío 12345678', '12345678'],
    ['numero di tracciamento 12345678', '12345678'],
    ['n.º de rastreio 12345678', '12345678'],
    ['Numer przesyłki 12345678', '12345678'],
    ['Número de rastreo: 12345678', '12345678'],
    ['Número de guía 12345678', '12345678'],
    ['Guía: 12345678', '12345678'],
    ['WAYBILL 1234567890', '1234567890'],
    ['WAYBILL1234567890', '1234567890'],
    ['Tracking1234567890', '1234567890'],
    ['AWB No. 1234567890', '1234567890'],
  ])('leaves a label word out of a short entry: %s', (input, number) => {
    expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: number, source: 'text' });
  });

  it('leaves out a tracking word pasted onto a number only when a carrier confidently claims the rest', () => {
    for (const input of ['SuiviJRT0000000001MM', 'SUIVIJRT0000000001MM', 'Suivi:JRT0000000001MM', 'trackingJRT0000000001MM']) {
      expect(parseTrackingInput(input), input).toMatchObject({ trackingNumber: 'JRT0000000001MM', carrier: 'jrt', confidence: 'high' });
    }
    expect(parseTrackingInput('SUIVIRR123456785FR')).toMatchObject({ trackingNumber: 'RR123456785FR', confidence: 'high' });
    for (const input of ['SuiviJRT0000000001', 'SuiviABC123', 'SuiviColis']) {
      expect(parseTrackingInput(input).confidence, input).not.toBe('high');
      expect(parseTrackingInput(input).trackingNumber, input).not.toMatch(/^JRT/);
    }
  });

  it('reads a waybill named in a message', () => {
    for (const input of ['Your DHL waybill 1234567890 is ready', 'Waybill No. 1234567890 has shipped', 'Tu número de guía es 1234567890']) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: '1234567890', source: 'text' });
    }
  });

  it('reads no Amazon number from a word before ten digits, and still reads Amazon\'s capitals before them', () => {
    for (const input of ['Su número de seguimiento es 1234567890', 'Tracking No. 1234567890', 'TRACKING NO. 1234567890', 'Your parcel No. 1234567890 has shipped']) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: '1234567890', carrier: 'unknown', source: 'text' });
    }
    for (const input of ['Track it 1234567890 today', 'Order No. 1234567890']) {
      expect(parseTrackingInput(input).carrier).not.toBe('amazon-logistics');
    }
    for (const [input, number] of [['Tracking ID: DE1234567890', 'DE1234567890'], ['Your parcel: FR 0000-000001', 'FR 0000-000001'],
      ['Your parcel TBA 1234 5678 9012 is on its way', 'TBA 1234 5678 9012']] as const) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: number, carrier: 'amazon-logistics', source: 'text' });
    }
  });

  it('reads no entry with a word in it whole', () => {
    expect(parseTrackingInput('Suivi colis 12345678')).toMatchObject({ trackingNumber: '12345678', source: 'text' });
    expect(parseTrackingInput('Ihre Bestellung 12345678')).toMatchObject({ trackingNumber: '', source: 'none' });
    expect(parseTrackingInput('1Z 999 AA1 01 2345 6784')).toMatchObject({ carrier: 'ups', source: 'number' });
  });

  it('takes no other number a label names for the tracking number', () => {
    for (const input of ['numéro de commande 12345678', 'número de pedido 12345678', 'suivi 5555666677 ou 7777888899', 'Order number 12345678',
      'Bestellnummer 12345678', 'Commande n° 12345678', 'Telefonnummer 0612345678', 'Customer ID: 12345678']) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: '', source: 'none' });
    }
  });

  it('keeps a short entry whole when its letters are no label word, or touch the digits', () => {
    // Letters a carrier prints apart from its digits stay on the number.
    for (const input of ['QZX 123456', 'ABCD 1234567', 'LP 00123456789012', '1111 2222 3333 4444', '1Z 999 AA1 01 2345 6784', 'abholcode123456', 'AWB1234567890']) {
      expect(parseTrackingInput(input)).toMatchObject({ trackingNumber: input, source: 'number' });
    }
  });

  it.each(['or', 'oder', 'ou', 'o', 'of', 'lub'])('reads no single number from two numbers joined by "%s"', (word) => {
    expect(parseTrackingInput(`5555666677 ${word} 7777888899`)).toMatchObject({ trackingNumber: '', source: 'none' });
  });

  it('keeps other numeric carriers ambiguous', () => {
    expect(detectCarrierMatch('123456789012345')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('87979.0061660090')).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch('06080000000002').candidates[0]).toBe('dpd');
  });

  it('recognizes the PostLogistics printed reference without claiming every 11-digit number', () => {
    expect(parseTrackingInput('19999980-001')).toMatchObject({
      trackingNumber: '19999980-001', carrier: 'postlogistics', confidence: 'high', source: 'number',
    });
    expect(detectCarrier('19999980001')).not.toBe('postlogistics');
    expect(parseTrackingInput('https://tracking.postlogistics.ch/public/trackandtrace/19999980-001'))
      .toMatchObject({ trackingNumber: '19999980-001', carrier: 'postlogistics', source: 'link' });
    // Its tracking page moved to Swiss Post Cargo's tracker, whose links keep the reference with it.
    expect(parseTrackingInput('https://apv.swisspost-cargo.com/public/trackandtrace/19999980-001'))
      .toMatchObject({ trackingNumber: '19999980-001', carrier: 'postlogistics', source: 'link' });
    expect(formatTrackingNumber('19999980001', 'postlogistics')).toBe('19999980-001');
    expect(formatTrackingNumber('19999980001')).toBe('19999980001');
  });

  it('suggests Swiss Post Cargo for a PL reference, printed or compact, and asks it to confirm', () => {
    // TNT Italy's national waybills and GLS Italy's shipments have the compact shape too, so all are asked.
    for (const number of ['PL-99999981', 'pl99999981']) {
      expect(parseTrackingInput(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['swiss-post-cargo', 'gls-it', 'tnt-it'] });
      expect(recognitionAskedCarriers(number)).toEqual(['gls-it', 'tnt-it', 'swiss-post-cargo']);
    }
    for (const number of ['PL-9999998', 'PL-999999819', 'PX-99999981']) {
      expect(detectCarrierMatch(number).candidates).not.toContain('swiss-post-cargo');
    }
  });

  it('reads Swiss Post Cargo links from both tracker hosts, keeping a reference as printed', () => {
    for (const host of ['apv', 'tt']) {
      expect(parseTrackingInput(`https://${host}.swisspost-cargo.com/public/trackandtrace/AB-99999981`))
        .toMatchObject({ trackingNumber: 'AB-99999981', carrier: 'swiss-post-cargo', confidence: 'high', source: 'link' });
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
    ['ppl', '29000000001', [
      'https://www.ppl.cz/?form=track-and-trace&shipmentId=',
      'https://www.ppl.cz/vyhledat-zasilku?shipmentId=',
      'https://www.ppl.cz/en/track-a-shipment?shipmentId=',
    ], 'https://www.ppl.cz/zasilky?shipmentId='],
    ['fukuyama', '12345678901', [
      'https://seikyu.fukuyama-tsuun.com/corp/tracking_no_hunt/',
      'https://corp.fukutsu.co.jp/corp/recieve/tracking_no_hunt/',
      'https://corp.fukutsu.co.jp/situation/tracking_no_hunt/',
    ], 'https://seikyu.fukuyama-tsuun.com/corp/'],
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

  it('reads DHL Express waybills on its tracking page, and leaves DHL Paket its own numbers there', () => {
    const page = 'https://www.logistics.dhl/it-it/home/tracking/tracking-express.html?submit=1&tracking-id=';
    expect(parseTrackingInput(`${page}1234567891`)).toMatchObject({
      trackingNumber: '1234567891', carrier: 'dhl-express', confidence: 'high', source: 'link',
    });
    expect(parseTrackingInput(`${page}CX123456785DE`)).toMatchObject({
      trackingNumber: 'CX123456785DE', carrier: 'dhl', confidence: 'high', source: 'link',
    });
    const other = 'https://www.logistics.dhl/it-it/home/tracking.html?tracking-id=1234567891';
    expect(parseTrackingInput(other)).toEqual(parseTrackingInput('https://example.test/it-it/home/tracking.html?tracking-id=1234567891'));
  });

  it('reads TNT consignments on tnt.com tracking pages, and leaves other numbers there to detection', () => {
    for (const page of [
      'https://www.tnt.com/express/it_it/site/shipping-tools/tracking.html?searchType=con&cons=',
      'https://www.tnt.com/express/en_gb/site/shipping-tools/tracking.html?respCountry=gb&respLang=en&searchType=CON&cons=',
      'https://www.tnt.com/express/es_es/site/herramientas-envio/seguimiento.html?searchType=CON&cons=',
      'https://www.tnt.com/express/fr_fr/site/outils-expedition/suivi.html?searchType=con&cons=',
      'https://www.tnt.com/express/it_ch/site/strumenti-spedizione/tracking.html?searchType=con&cons=',
      'https://www.tnt.com/express/es_es/site/herramientas-envio/seguimiento.html?cons=',
    ]) {
      // tnt.com completes an eight-digit serial with its check digit, as the adapter does.
      for (const number of ['123456785', 'GE123456785WW', '12345678']) {
        expect(parseTrackingInput(`${page}${number}`)).toMatchObject({ trackingNumber: number, carrier: 'tnt', confidence: 'high', source: 'link' });
      }
      expect(parseTrackingInput(`${page}123456789`).carrier).not.toBe('tnt');
      expect(parseTrackingInput(`${page}1234567`).carrier).not.toBe('tnt');
    }
    // The page's share link.
    expect(parseTrackingInput('https://www.tnt.com/track?cons=12345678&searchType=CON&source=share'))
      .toMatchObject({ trackingNumber: '12345678', carrier: 'tnt', confidence: 'high', source: 'link' });
    // A search by the sender's reference holds no consignment number.
    for (const number of ['12345678', '123456785']) {
      expect(parseTrackingInput(`https://www.tnt.com/express/es_es/site/herramientas-envio/seguimiento.html?searchType=REF&cons=${number}`).carrier).not.toBe('tnt');
      expect(parseTrackingInput(`https://www.tnt.com/track?cons=${number}&searchType=ref`).carrier).not.toBe('tnt');
    }
  });

  it('reads the Freightways networks’ receiver and ITNG links, keeping a customer printed label’s consignment number', () => {
    for (const [carrier, domain, code] of [
      ['nz-couriers', 'nzcouriers.co.nz', 'nzc'],
      ['post-haste', 'posthaste.co.nz', 'phl'],
      ['castle-parcels', 'castleparcels.co.nz', 'cpl'],
      ['now-couriers', 'nowcouriers.co.nz', 'now'],
    ] as const) {
      const read = (url: string, trackingNumber: string) => expect(parseTrackingInput(url), url)
        .toMatchObject({ trackingNumber, carrier, confidence: 'high', source: 'link' });
      read(`https://receiver.${domain}/?consignmentid=CU..ZZZ047193.Z.0000000.1`, 'ZZZ047193');
      read(`https://receiver.${domain}/?consignmentId=CU..ZZZZ0471935.Z.ZZZZZZ0.1`, 'ZZZZ0471935');
      read(`https://receiver.${domain}/?track=ZZ%2004719352`, 'ZZ 04719352');
      read(`https://receiver.${domain}/?Key_Type=Charge&label_number=04719352`, '04719352');
      read(`https://tools.${domain}/${code}/servlet/ITNG_TAndTServlet?page=1&VCCA=Enabled&Key_Type=CustomerLabel`
        + '&customer_number=0000000&consignment_id=ZZZ047193', 'ZZZ047193');
      // A ticket's or charge label's composite names no number a tracker reads.
      expect(parseTrackingInput(`https://receiver.${domain}/?track=FW.TK..ZZ.04719352`).carrier).not.toBe(carrier);
    }
  });
});

describe('delivering partners\' links', () => {
  it.each([
    ['bpost', 'https://track.bpost.cloud/etr/light/performSearch.do?searchByItemCode=true&itemCodes='],
    ['poste-italiane', 'https://www.sda.it/wps/portal/Servizi_online/dettaglio-spedizione?locale=it&tracing.letteraVettura='],
  ])('%s %s', (carrier, page) => {
    expect(parseTrackingInput(`${page}TESTA1`)).toMatchObject({ trackingNumber: 'TESTA1', carrier, confidence: 'high', source: 'link' });
  });
});

describe('checksum rejections', () => {
  it('names the rule whose failed checksum kept its carrier out of the suggestions', () => {
    const waybill = { carrier: 'dhl-express', rule: 'dhl-express-waybill', checksum: 'dhl-express' };
    expect(checksumRejections('1234567890')).toEqual([{ carrier: 'acs-courier', rule: 'acs-courier-1', checksum: 'mod7' }, waybill,
      { carrier: 'geniki-taxydromiki', rule: 'geniki-taxydromiki-1', checksum: 'mod7' }]);
    // ACS and Geniki Taxydromiki print ten plain digits.
    expect(checksumRejections('1 234 567-890')).toEqual([waybill]);
    expect(checksumRejections('1234567891')).toEqual([]);
    expect(checksumRejections('RA999999989CH')).toContainEqual({ carrier: 'swiss-post', rule: 'swiss-post-1', checksum: 's10' });
    expect(checksumRejections('RA999999987CH')).toEqual([]);
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
    expect(checksumFailures('1 234 567-890')).toEqual(checksumRejections('1 234 567-890'));
    expect(checksumFailures('1234567891')).toEqual([]);
    expect(checksumFailures('')).toEqual([]);
    for (const number of ['1234567890', '123456789012', '123456789013', '123456789012345', '250123456789010', 'RA999999989CH']) {
      expect(checksumFailures(number)).toEqual(expect.arrayContaining(checksumRejections(number)));
    }
  });

  it('has one id for each catalog rule', () => {
    for (const [carrier, definition] of Object.entries(CARRIER_DEFINITIONS)) {
      expect(DETECTION_RULE_IDS[carrier as keyof typeof DETECTION_RULE_IDS]).toHaveLength(definition.detectionRules.length);
    }
  });
});

it('keeps a Swiss Post barcode grouped in two nine-digit blocks', () => {
  const grouped = '99' + '0'.repeat(7) + ' ' + '1'.repeat(9);
  expect(parseTrackingInput('https://www.post.ch/swisspost-tracking?formattedParcelCodes=' + encodeURIComponent(grouped)).trackingNumber).toBe(grouped);
});

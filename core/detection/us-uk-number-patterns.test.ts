import { describe, expect, it } from 'vitest';
import { recognitionCandidates } from '../catalog/recognition.js';
import { checksumRejections, detectCarrierMatch, parseTrackingInput } from './index.js';
import { isValidFedEx1DBarcode } from './fedex.js';
import { isValidUspsPackageBarcode, uspsPackageIdentifier } from './usps.js';
import { normalizeUSPSNumber, parseUSPSTrackingHtml, uspsTrackingUrl } from '../../carriers/usps/adapter.js';
import { normalizeRoyalMailNumber, parseRoyalMailTrackingResponse, royalMailSummaryApiUrl } from '../../carriers/royal-mail/parser.js';
import { normalizeIntelcomNumber } from '../../carriers/intelcom/parser.js';

// Synthetic identifiers; the PIC check digit is calculated independently.
const PIC = '9210090000000012345679';
const PIC26 = '92000000000123456789012344';
// Channel 93 with a six-digit Mailer ID; its last 22 digits also pass the check
// digit, as a channel 92 PIC whose Mailer ID does not start with 9.
const WIDE = '93009200000000123456789013';

describe('USPS whole package barcodes', () => {
  it('uses the PIC checksum without counting its routing prefix', () => {
    expect(isValidUspsPackageBarcode(PIC)).toBe(true);
    for (const zip of ['00000', '000000000']) {
      const raw = `420${zip}${PIC}`;
      expect(uspsPackageIdentifier(raw)).toBe(PIC);
      expect(normalizeUSPSNumber(raw)).toBe(PIC);
      expect(new URL(uspsTrackingUrl(raw)).searchParams.get('tLabels')).toBe(PIC);
    }
  });

  it('selects USPS for a routing barcode when the bare PIC rule would select it', () => {
    for (const zip of ['00000', '000000000']) {
      for (const pic of [PIC, '9300100000012345678902', '9400100000000123456780', '9505500000000123456782', '9101900000000123456788']) {
        expect(detectCarrierMatch(`420${zip}${pic}`)).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
        expect(recognitionCandidates(`420${zip}${pic}`, { phase: 'browser' })).toEqual([]);
      }
      // A Mailer ID that does not fit its channel, or a family DHL eCommerce also tracks.
      for (const pic of ['9205510000000012345670', '9300190000012345678903', '9100000000000000000002', '9261290000000012345677', '9361200000012345678900']) {
        const raw = `420${zip}${pic}`;
        expect(detectCarrierMatch(raw)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
        expect(detectCarrierMatch(raw).preferred).toContain('usps');
        const dhl = zip.length === 5 && /^9[23]61/.test(pic);
        expect(recognitionCandidates(raw).map(candidate => candidate.carrier)).toEqual(dhl ? ['dhl-ecommerce'] : []);
        expect(recognitionCandidates(raw, { phase: 'browser' }).map(candidate => candidate.carrier)).toContain('usps');
      }
    }
    expect(detectCarrierMatch(`42000000${PIC.slice(0, -1)}1`).candidates).not.toContain('usps');
    // The zeros and the last twelve digits also fit FedEx's 34-digit barcode and pass its check.
    const shared = '4200000000009210090000000012340094';
    expect(isValidFedEx1DBarcode(shared)).toBe(true);
    expect(detectCarrierMatch(shared)).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
  });

  it('keeps a suggestion when a ZIP+4 add-on could open a 26-digit PIC', () => {
    // The PIC after ZIP+4 9201 is the identifier: the 26-digit reading's Mailer ID does not fit.
    expect(uspsPackageIdentifier(`420000009201${PIC}`)).toBe(PIC);
    expect(detectCarrierMatch(`420000009201${PIC}`)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
    // Here the 22 digits after ZIP+4 9301 fail the check and the 26 after the ZIP pass it.
    const raw = `420000009301${PIC.slice(0, -1)}8`;
    expect(uspsPackageIdentifier(raw)).toBe(raw.slice(8));
    expect(detectCarrierMatch(raw)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
  });

  it('accepts a complete 26-digit PIC, without treating the checksum as ownership', () => {
    expect(PIC26).toHaveLength(26);
    expect(normalizeUSPSNumber(PIC26)).toBe(PIC26);
    expect(normalizeUSPSNumber(`42000000${PIC26}`)).toBe(PIC26);
    expect(detectCarrierMatch(PIC26)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
  });

  it('selects USPS for a 26-digit channel 92 PIC whose Mailer ID fits', () => {
    // A made-up channel 92 PIC with a nine-digit MID.
    expect(detectCarrierMatch('92055900000000000123456786')).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
    expect(recognitionCandidates('92055900000000000123456786')).toEqual([]);
    // Channel 93 at 26 digits has too few public examples, so it stays a suggestion.
    expect(detectCarrierMatch('93001000000001234567890125')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
    expect(detectCarrierMatch('92055900000000000123456787')).toMatchObject({ carrier: 'unknown', confidence: 'none' });
    // The 9261 family stays a suggestion, as at 22 digits.
    expect(detectCarrierMatch('92612900000000000123456781')).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
  });

  it('reads the retail and legacy channels only as 22-digit PICs', () => {
    for (const pic of ['9500000000000000000008', '9100000000000000000002']) {
      expect(isValidUspsPackageBarcode(pic)).toBe(true);
      expect(detectCarrierMatch(pic).candidates[0]).toBe('usps');
    }
    // A ZIP+4 add-on starting 91 would otherwise pass as the start of a 26-digit PIC.
    expect(uspsPackageIdentifier(`420123459102${PIC}`)).toBe(PIC);
  });

  it('selects USPS for a 22-digit PIC with a channel, a conforming Mailer ID and a passing check digit', () => {
    // Made-up PICs for channels 92 (nine-digit MID), 93 (six-digit MID), 94 (online), 95 (retail) and legacy 91.
    for (const pic of [PIC, '9300100000012345678902', '9400100000000123456780', '9505500000000123456782', '9101900000000123456788']) {
      expect(detectCarrierMatch(pic)).toMatchObject({ carrier: 'usps', confidence: 'high', candidates: ['usps'] });
      expect(recognitionCandidates(pic)).toEqual([]);
    }
    // A nine-digit MID starts with 9 and a six-digit one never does.
    for (const pic of ['9205510000000012345670', '9300190000012345678903', '9100000000000000000002']) {
      expect(isValidUspsPackageBarcode(pic)).toBe(true);
      expect(detectCarrierMatch(pic)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
    }
    expect(detectCarrierMatch(`${PIC.slice(0, -1)}1`)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: [] });
    // DHL eCommerce tracks its 9261 and 9361 families too, so they stay suggestions.
    for (const pic of ['9261290000000012345677', '9361200000012345678900']) {
      expect(isValidUspsPackageBarcode(pic)).toBe(true);
      expect(detectCarrierMatch(pic)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
      expect(detectCarrierMatch(pic).candidates).toContain('dhl-ecommerce');
    }
  });

  it('reads a ZIP+4 before a 26-digit PIC, the only split of 38 digits', () => {
    const raw = `420000000000${PIC26}`;
    expect(raw).toHaveLength(38);
    expect(uspsPackageIdentifier(raw)).toBe(PIC26);
    expect(normalizeUSPSNumber(raw)).toBe(PIC26);
    expect(new URL(uspsTrackingUrl(raw)).searchParams.get('tLabels')).toBe(PIC26);
    expect(uspsPackageIdentifier(`420000000000${PIC26.slice(0, -1)}5`)).toBeNull();
  });

  it('settles a 34-digit split by the Mailer ID layout when both readings pass the check digit', () => {
    // ZIP+4 9201 makes a channel 92 PIC whose Mailer ID does not start with 9.
    expect(uspsPackageIdentifier(`420000009201${PIC}`)).toBe(PIC);
    expect(normalizeUSPSNumber(`420000009201${PIC}`)).toBe(PIC);
    // The 22-digit reading of this ZIP5 barcode is that kind of channel 92 PIC.
    expect(isValidUspsPackageBarcode(WIDE.slice(4))).toBe(true);
    expect(uspsPackageIdentifier(`42000000${WIDE}`)).toBe(WIDE);
    expect(normalizeUSPSNumber(`42000000${WIDE}`)).toBe(WIDE);
  });

  it('refuses wrong checksums, malformed routing and ZIP/PIC splits the layout cannot settle', () => {
    // ZIP+4 9300 reads as a channel 93 PIC with a six-digit Mailer ID, as valid as the PIC after it.
    expect(isValidUspsPackageBarcode(`9300${PIC}`)).toBe(true);
    for (const raw of [`42000000${PIC.slice(0, -1)}1`, `420ABCDE${PIC}`, `4200000${PIC}`, `420000000${PIC}`, `420000009300${PIC}`]) {
      expect(uspsPackageIdentifier(raw)).toBeNull();
      expect(() => normalizeUSPSNumber(raw)).toThrow();
      expect(detectCarrierMatch(raw).candidates).not.toContain('usps');
    }
  });

  it('binds a routed input to its canonical PIC when reading the page', () => {
    const page = `<div class="track-bar-container"><span id="trackingNum">${PIC}</span></div>`
      + '<div class="latest-update-banner-wrapper"><div class="banner-header">Tracking Not Available</div></div>';
    expect(parseUSPSTrackingHtml(page, `42000000${PIC}`)).toMatchObject({ status: 'unknown', events: [] });
    expect(() => parseUSPSTrackingHtml(page.replace(PIC, PIC.slice(0, -1) + '1'), `42000000${PIC}`)).toThrow('requested parcel');
  });
});

describe('Royal Mail domestic references', () => {
  it('does not offer a plain hexadecimal word or a partial reference', () => {
    for (const raw of ['ABCDEFABCDEFABCD', '000000A000BC0D0', '3200000000000ABCDEFGH']) {
      expect(detectCarrierMatch(raw).candidates).not.toContain('royal-mail');
      expect(() => normalizeRoyalMailNumber(raw)).toThrow();
    }
  });
  it.each(['32-000 000 0000-000 ABC DEF', '000000A000BC0D00'])('keeps a complete reference through detection and submission: %s', raw => {
    const number = normalizeRoyalMailNumber(raw);
    expect(detectCarrierMatch(raw)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
    expect(detectCarrierMatch(raw).candidates).toContain('royal-mail');
    expect(recognitionCandidates(raw)).toEqual([]);
    expect(recognitionCandidates(raw, { phase: 'browser' }).map(candidate => candidate.carrier)).toContain('royal-mail');
    expect(royalMailSummaryApiUrl(raw)).toContain(number);
    expect(parseTrackingInput(raw).trackingNumber).toBe(raw);
    const payload = { mailPieces: { mailPieceId: number, summary: { statusCategory: 'DELIVERED' }, events: [] } };
    expect(parseRoyalMailTrackingResponse(payload, raw)).toHaveProperty('status');
    expect(() => parseRoyalMailTrackingResponse({ mailPieces: { ...payload.mailPieces, mailPieceId: '000000A000BC0D01' } }, raw)).toThrow('requested parcel');
  });
});

describe('JJD licence plates', () => {
  it('suggests InPost beside DHL for the plate length Yodel prints', () => {
    const yodel = 'JJD0002000000000001';
    expect(detectCarrierMatch(yodel)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['dhl', 'inpost'] });
    expect(recognitionCandidates(yodel).map(candidate => candidate.carrier)).toEqual(['inpost']);
  });

  it('keeps every other JJD plate with DHL', () => {
    for (const plate of ['JJD0099999999', 'JJD000200000000000', 'JJD00020000000000000', 'JJD000200000000000A', 'JJD000000000000000000000000']) {
      expect(detectCarrierMatch(plate)).toMatchObject({ carrier: 'dhl', confidence: 'high' });
    }
  });
});

describe('UK fourteen-digit parcel numbers', () => {
  // Synthetic numbers in the ranges the carriers' own tracking pages show.
  it.each([['15500000000001', 'dpd-uk'], ['15500000000001M', 'dpd-uk'], ['60120000000000', 'dhl-ecommerce-uk']])(
    'suggests the carrier of its range first: %s', (number, carrier) => {
      expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low' });
      expect(detectCarrierMatch(number).candidates[0]).toBe(carrier);
    });

  it('suggests neither first outside those ranges, nor for a wrong check character', () => {
    expect(detectCarrierMatch('31500000000000').candidates.slice(0, 1)).not.toEqual(expect.arrayContaining(['dpd-uk', 'dhl-ecommerce-uk']));
    expect(detectCarrierMatch('15500000000001N').candidates).not.toContain('dpd-uk');
  });
});

it('recognizes every lettered Intelcom series', () => {
  for (const number of ['INTLCMD123456789', 'INTLCMJ123456789', 'INTLCMR123456789']) {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'intelcom', confidence: 'high' });
    expect(normalizeIntelcomNumber(number)).toBe(number);
    expect(parseTrackingInput(`Tracking number: ${number}`).trackingNumber).toBe(number);
    expect(detectCarrierMatch(`${number}0`).carrier).toBe('unknown');
  }
  expect(detectCarrierMatch('INTLCMJ12345678').carrier).toBe('unknown');
});

it('suggests Old Dominion for eleven-digit PROs only when the Luhn check passes', () => {
  // Synthetic PROs outside the prefixes Old Dominion's high rules claim.
  for (const number of ['12300000002', '45600000017']) {
    expect(detectCarrierMatch(number).candidates).toContain('old-dominion');
  }
  for (const number of ['12300000003', '45600000018', '1230000002', '123000000002']) {
    expect(detectCarrierMatch(number).candidates).not.toContain('old-dominion');
  }
});

it('selects Old Dominion by its PRO prefixes only when the Luhn check passes', () => {
  // Synthetic PROs on each prefix the high rules claim, and twins with another check digit.
  for (const number of ['07200000011', '77700000001', '77800000000', '78000000022', '80000000002']) {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'old-dominion', confidence: 'high' });
  }
  for (const number of ['07200000012', '77700000002', '77800000001', '78000000023', '80000000003']) {
    expect(detectCarrierMatch(number).candidates).not.toContain('old-dominion');
  }
  expect(checksumRejections('77700000002')).toContainEqual({ carrier: 'old-dominion', rule: 'old-dominion-1', checksum: 'luhn' });
  expect(checksumRejections('80000000003')).toContainEqual({ carrier: 'old-dominion', rule: 'old-dominion-2', checksum: 'luhn' });
});

it('suggests UniUni for cross-border shipper references without selecting it', () => {
  for (const number of ['GV00CAA0U000000001', 'JY00CAA0D000000001']) {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['uniuni'] });
  }
  for (const number of ['GV00CAA1U000000001', 'GV00CAA0U00000001', 'G100CAA0U000000001', 'GV00CAA0U0000000001']) {
    expect(detectCarrierMatch(number).candidates).not.toContain('uniuni');
  }
});

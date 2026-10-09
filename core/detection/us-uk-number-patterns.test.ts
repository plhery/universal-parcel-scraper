import { describe, expect, it } from 'vitest';
import { recognitionCandidates } from '../catalog/recognition.js';
import { detectCarrierMatch, parseTrackingInput } from './index.js';
import { isValidUspsPackageBarcode, uspsPackageIdentifier } from './usps.js';
import { normalizeUSPSNumber, parseUSPSTrackingHtml, uspsTrackingUrl } from '../../carriers/usps/adapter.js';
import { normalizeRoyalMailNumber, parseRoyalMailTrackingResponse, royalMailSummaryApiUrl } from '../../carriers/royal-mail/parser.js';
import { normalizeIntelcomNumber } from '../../carriers/intelcom/parser.js';

// Synthetic identifiers; the PIC check digit is calculated independently.
const PIC = '9210090000000012345679';
const PIC26 = '92000000000123456789012344';

describe('USPS whole package barcodes', () => {
  it('uses the PIC checksum without counting its routing prefix', () => {
    expect(isValidUspsPackageBarcode(PIC)).toBe(true);
    for (const zip of ['00000', '000000000']) {
      const raw = `420${zip}${PIC}`;
      expect(uspsPackageIdentifier(raw)).toBe(PIC);
      expect(normalizeUSPSNumber(raw)).toBe(PIC);
      expect(new URL(uspsTrackingUrl(raw)).searchParams.get('tLabels')).toBe(PIC);
      expect(detectCarrierMatch(raw)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
      expect(recognitionCandidates(raw)).toEqual([]);
      expect(recognitionCandidates(raw, { phase: 'browser' }).map(candidate => candidate.carrier)).toContain('usps');
    }
  });

  it('accepts a complete 26-digit PIC, without treating the checksum as ownership', () => {
    expect(PIC26).toHaveLength(26);
    expect(normalizeUSPSNumber(PIC26)).toBe(PIC26);
    expect(normalizeUSPSNumber(`42000000${PIC26}`)).toBe(PIC26);
    expect(detectCarrierMatch(PIC26)).toMatchObject({ carrier: 'unknown', confidence: 'low', preferred: ['usps'] });
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

  it('refuses wrong checksums, malformed routing and ambiguous ZIP/PIC splits', () => {
    for (const raw of [`42000000${PIC.slice(0, -1)}1`, `420ABCDE${PIC}`, `4200000${PIC}`, `420000000${PIC}`, `420000000000${PIC26}`,
      `420000009201${PIC}`]) {
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

it('suggests UniUni for cross-border shipper references without selecting it', () => {
  for (const number of ['GV00CAA0U000000001', 'JY00CAA0D000000001']) {
    expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'unknown', confidence: 'low', candidates: ['uniuni'] });
  }
  for (const number of ['GV00CAA1U000000001', 'GV00CAA0U00000001', 'G100CAA0U000000001', 'GV00CAA0U0000000001']) {
    expect(detectCarrierMatch(number).candidates).not.toContain('uniuni');
  }
});

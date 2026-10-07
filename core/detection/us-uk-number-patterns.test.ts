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

it('recognizes the whole Intelcom INTLCMD family', () => {
  const number = 'INTLCMD123456789';
  expect(detectCarrierMatch(number)).toMatchObject({ carrier: 'intelcom', confidence: 'high' });
  expect(normalizeIntelcomNumber(number)).toBe(number);
  expect(parseTrackingInput(`Tracking number: ${number}`).trackingNumber).toBe(number);
  expect(detectCarrierMatch(`${number}0`).carrier).toBe('unknown');
});

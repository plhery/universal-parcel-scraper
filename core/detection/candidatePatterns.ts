// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 Paul-Louis Hery
/**
 * The shapes of a tracking number inside free text.
 *
 * What it is: the patterns tried when a whole shipping message, or a URL with
 * no matching link rule, is pasted. Apps bundle them as data, so they are
 * licensed under AGPL-3.0-only, as NOTICE says, unlike the scans that use them.
 * What it is not: no scan of its own (candidates.ts) and no carrier decision.
 */
import { AMAZON_NUMBER_PATTERN } from './amazon.js';

const AMAZON_TEXT_PATTERN = AMAZON_NUMBER_PATTERN.slice(1, -1).replaceAll('[0-9]', '(?:[\\s.-]*[0-9])');

export const TRACKING_CANDIDATE_PATTERNS = [
  // Amazon's digits can be printed in groups. A country's two letters set apart from them are
  // capitals and no abbreviation: "es" in "Su número de seguimiento es 1234567890" and "No." in
  // "Tracking No. 1234567890" are words, not Amazon's.
  new RegExp(`\\b(?![A-Z]{2}[\\s.-])${AMAZON_TEXT_PATTERN}\\b`, 'gi'),
  new RegExp(`\\b(?![A-Z]{2}\\.)${AMAZON_TEXT_PATTERN}\\b`, 'g'),
  // NACEX agency/shipment composites keep their slash boundary (never stripped).
  /\b\d{4}\/\d{8}\b/g,
  // NO LIMIT's shipment numbers are printed with slashes, which normalization drops.
  /\bP\/\d{1,6}\/L[A-Z]{3}\/20\d{2}\b/gi,
  // MRW prints a slash after the office's five digits, which normalization drops.
  /\b\d{5}\/(?:\d{7}|[A-Z]\d{6})\b/gi,
  /\b\d{26}\b/g,
  /\bH\d{15,19}\b/gi,
  /\b1Z[A-Z0-9]{16}\b/gi,
  /\b1G[A-Z0-9]{10}\b/gi,
  /\b[A-Z]{2}\s*\d(?:[\s.-]?\d){8}\s*[A-Z]{2}\b/gi,
  /\b(?:JJD|JVGL)[A-Z0-9]{8,}\b/gi,
  /\b\d(?:[\s.-]?\d){9,19}\b/g,
  // Let catalog rules claim other complete identifiers without copying their shapes here.
  /\b[A-Z0-9]{4,40}\b/gi,
];

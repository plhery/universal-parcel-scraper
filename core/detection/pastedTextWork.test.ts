import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CARRIER_DEFINITIONS } from '../catalog/definitions.js';
import { MOST_TEXT_CANDIDATES } from './candidates.js';
import { detectCarrierMatch } from './detect.js';
import { parseTrackingInput } from './parse.js';
import { compiledRuleFits } from './rules.js';

// The work a paste costs, counted through the engine's own modules: each
// detection the scans ask for, and each rule tried on its own.
vi.mock('./detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./detect.js')>();
  return { ...actual, detectCarrierMatch: vi.fn(actual.detectCarrierMatch) };
});
vi.mock('./rules.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rules.js')>();
  return { ...actual, compiledRuleFits: vi.fn(actual.compiledRuleFits) };
});

const LIMIT = 16_384;
const detections = vi.mocked(detectCarrierMatch);
const ruleTests = vi.mocked(compiledRuleFits);
const catalogRules = Object.values(CARRIER_DEFINITIONS).reduce((count, definition) => count + definition.detectionRules.length, 0);
const letters = (value: number) => value.toString(26).replace(/./g, (digit) => String.fromCharCode(97 + parseInt(digit, 26)));

beforeEach(() => {
  detections.mockClear();
  ruleTests.mockClear();
});

describe('the work a pasted text costs', () => {
  it.each([
    ['one word repeated', Array(3000).fill('abcd').join(' '), 3],
    ['one unknown link repeated', Array(612).fill('https://example.invalid/track/abcd/efgh').join(' '), 8],
    ['distinct words', Array.from({ length: 2800 }, (_, index) => `w${letters(index)}`).join(' '), MOST_TEXT_CANDIDATES],
    ['distinct numbers', Array.from({ length: 2000 }, (_, index) => String(1_000_000 + index * 7)).join(' '), MOST_TEXT_CANDIDATES],
    ['distinct unknown links', Array.from({ length: 500 }, (_, index) => `https://e${index}.invalid/t/a${index}bc/q${index}gh`).join(' '), MOST_TEXT_CANDIDATES],
  ])('asks about each candidate of %s once, and about no more than the budget', (_, text, most) => {
    expect(parseTrackingInput(text.slice(0, LIMIT))).toMatchObject({ source: 'none' });
    expect(detections.mock.calls.length).toBeLessThanOrEqual(most + 2);
    // A rule is tried on its own only in a group of rules that fits the number: a small share of the catalog.
    expect(ruleTests.mock.calls.length).toBeLessThan(detections.mock.calls.length * catalogRules / 5);
  });

  it('still reads a number after a long message’s words', () => {
    const words = Array.from({ length: 1000 }, (_, index) => `w${letters(index)}`).join(' ');
    expect(parseTrackingInput(`${words} Suivi : 87001234567890I`)).toMatchObject({
      trackingNumber: '87001234567890I', carrier: 'la-poste', confidence: 'high', source: 'text',
    });
  });
});

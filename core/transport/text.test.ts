import { describe, expect, it } from 'vitest';
import { clean, cleanScalar, escapeRegExp, repairMisreadUtf8, textFromHtml } from './text.js';

describe('text helpers', () => {
  it('collapses whitespace and caps length', () => {
    expect(clean('  Livré   au\n destinataire ')).toBe('Livré au destinataire');
    expect(clean('x'.repeat(600)).length).toBe(500);
    expect(clean(12)).toBe('');
    expect(cleanScalar(12)).toBe('12');
  });

  it('escapes regular expression metacharacters', () => {
    expect(new RegExp(escapeRegExp('a.b*c')).test('a.b*c')).toBe(true);
    expect(new RegExp(escapeRegExp('a.b*c')).test('aXbbbc')).toBe(false);
  });

  it('extracts readable text from short HTML fragments', () => {
    expect(textFromHtml('<b>Delivered</b>&nbsp;to <i>neighbour</i>')).toBe('Delivered to neighbour');
    expect(textFromHtml(null)).toBe('');
  });

  it('puts right UTF-8 read as Latin-1 and leaves real Latin-1 letters alone', () => {
    expect(repairMisreadUtf8('MÃ¼sterstadt, GroÃ\u009fdorf')).toBe('Müsterstadt, Großdorf');
    expect(repairMisreadUtf8('Pointâ\u0084¢')).toBe('Point™');
    expect(repairMisreadUtf8('Müsterstadt, São Paulo, Ãvila')).toBe('Müsterstadt, São Paulo, Ãvila');
  });
});

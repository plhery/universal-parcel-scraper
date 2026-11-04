import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import characters from '../../core/transport/text-captcha-model/characters.json' with { type: 'json' };
import { decodeChunghwaDigits, removeChunghwaGrid } from './captcha.mjs';
import { ChunghwaPostOcr } from './ocr.js';

describe('Chunghwa digit OCR', () => {
  it('removes long rules but preserves short strokes and the input buffer', () => {
    const pixels = new Uint8Array(162 * 54).fill(255);
    for (let x = 0; x < 162; x++) pixels[20 * 162 + x] = 0;
    for (let y = 0; y < 54; y++) pixels[y * 162 + 80] = 0;
    for (let y = 14; y < 28; y++) pixels[y * 162 + 30] = 0;
    const cleaned = removeChunghwaGrid(pixels, 162, 54);
    expect(cleaned[20 * 162 + 10]).toBe(255);
    expect(cleaned[10 * 162 + 80]).toBe(255);
    expect(cleaned[20 * 162 + 30]).toBe(0);
    expect(pixels[20 * 162 + 10]).toBe(0);
    expect(() => removeChunghwaGrid(pixels, 163, 54)).toThrow('unsupported-image');
  });

  it('decodes repeated digits with CTC blanks and scores a digit against competing letters', () => {
    const alphabet: Record<string, string> = characters;
    const index = (letter: string) => Number(Object.keys(alphabet).find(key => alphabet[key] === letter));
    const data = new Float32Array(6 * 8210).fill(-20);
    [index('0'), index('0'), 0, index('0'), index('7'), index('3')].forEach((value, step) => { data[step * 8210 + value] = 10; });
    const good = decodeChunghwaDigits(data, [6, 1, 8210], characters);
    expect(good.answer).toBe('0073');
    data[index('O')] = 15; data[8210 + index('O')] = 15;
    const uncertain = decodeChunghwaDigits(data, [6, 1, 8210], characters);
    expect(uncertain.answer).toBe('0073');
    expect(uncertain.confidence).toBeLessThan(good.confidence);
    data[0] = Number.NaN;
    expect(() => decodeChunghwaDigits(data, [6, 1, 8210], characters)).toThrow('Invalid OCR score');
    expect(() => decodeChunghwaDigits(data, [6, 8210], characters)).toThrow('Invalid OCR tensor');
  });

  it('loads the packaged model and recognizes a synthetic grid image, rejecting changed geometry', async () => {
    const worker = new ChunghwaPostOcr();
    const grid = Array.from({ length: 8 }, (_, i) => `<path d="M${i * 20} 0V54 M0 ${i * 7}H162"/>`).join('');
    const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="162" height="54"><rect width="162" height="54" fill="white"/><g stroke="black" stroke-width="1">${grid}</g><text x="8" y="40" font-family="serif" font-size="32" letter-spacing="10">7035</text></svg>`)).jpeg().toBuffer();
    try {
      expect(await worker.solve(image, AbortSignal.timeout(15_000))).toBe('7035');
      await expect(worker.solve(await sharp(image).resize(163, 54).jpeg().toBuffer(), AbortSignal.timeout(2000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 20_000);
});

import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeVnpostLogits, VNPOST_CHARACTERS } from './ocr-worker.mjs';
import { VnpostOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.jpg`, import.meta.url));

describe('VNPost captcha OCR', () => {
  it('reads the likeliest character at each of the four places', () => {
    const classes = VNPOST_CHARACTERS.length;
    const data = new Float32Array(4 * classes).fill(-10);
    [...'Z78r'].forEach((character, place) => { data[place * classes + VNPOST_CHARACTERS.indexOf(character)] = 10; });
    // A small "r" scored close to a capital "R" still reads as the higher score.
    data[3 * classes + VNPOST_CHARACTERS.indexOf('R')] = 9.5;
    expect(decodeVnpostLogits(data, [1, 4, classes])).toBe('Z78r');
    expect(() => decodeVnpostLogits(data, [4, classes])).toThrow('invalid tensor');
    data[0] = Number.NaN;
    expect(() => decodeVnpostLogits(data, [1, 4, classes])).toThrow('invalid score');
  });

  it('reads pictures the tracker accepted, and refuses another geometry', async () => {
    const worker = new VnpostOcr();
    try {
      for (const answer of ['Z78r', 'H45N']) expect(await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toBe(answer);
      const wider = await sharp(picture('Z78r')).resize(101, 40, { fit: 'fill' }).jpeg().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const png = await sharp(picture('Z78r')).png().toBuffer();
      await expect(worker.solve(png, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

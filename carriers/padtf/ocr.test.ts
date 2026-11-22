import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PadtfOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.png`, import.meta.url));

describe('PAD Express captcha OCR', () => {
  it('reads pictures the tracker drew, and refuses another geometry or format', async () => {
    const worker = new PadtfOcr();
    try {
      for (const answer of ['K36E', '3MB9']) expect(await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toBe(answer);
      const wider = await sharp(picture('K36E')).resize(80, 25, { fit: 'fill' }).png().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const jpeg = await sharp(picture('K36E')).jpeg().toBuffer();
      await expect(worker.solve(jpeg, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { YuxinOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.jpg`, import.meta.url));

describe('Yuxin Logistics captcha OCR', () => {
  it('reads pictures the tracker accepted, and refuses another geometry or format', async () => {
    const worker = new YuxinOcr();
    try {
      for (const answer of ['8ZMN', 'A7RS']) expect(await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toBe(answer);
      const wider = await sharp(picture('8ZMN')).resize(80, 26, { fit: 'fill' }).jpeg().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const png = await sharp(picture('8ZMN')).png().toBuffer();
      await expect(worker.solve(png, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SunspeedyOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.png`, import.meta.url));

describe('Sunspeedy verify code OCR', () => {
  it('reads pictures the tracker serves, and refuses another geometry or format', async () => {
    const worker = new SunspeedyOcr();
    try {
      for (const answer of ['7191', '0497', '3703', '8033']) expect(await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toBe(answer);
      const wider = await sharp(picture('7191')).resize(120, 30, { fit: 'fill' }).png().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const jpeg = await sharp(picture('7191')).jpeg().toBuffer();
      await expect(worker.solve(jpeg, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

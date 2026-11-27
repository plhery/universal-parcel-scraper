import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { HainanCargoOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.jpg`, import.meta.url));

describe('Hainan Airlines Cargo verify code OCR', () => {
  it('reads pictures the tracker serves, and refuses another geometry or format', async () => {
    const worker = new HainanCargoOcr();
    try {
      for (const answer of ['NZME', 'EKUV']) expect(await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toBe(answer);
      const wider = await sharp(picture('NZME')).resize(70, 25, { fit: 'fill' }).jpeg().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const png = await sharp(picture('NZME')).png().toBuffer();
      await expect(worker.solve(png, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

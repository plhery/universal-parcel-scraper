import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ProfessionalCouriersOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.png`, import.meta.url));

describe('The Professional Couriers captcha OCR', () => {
  it('reads pictures the tracker drew, and refuses another geometry or format', async () => {
    const worker = new ProfessionalCouriersOcr();
    try {
      for (const answer of ['9C8L2', '4P99X']) expect(await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toBe(answer);
      const wider = await sharp(picture('9C8L2')).resize(200, 44, { fit: 'fill' }).png().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const jpeg = await sharp(picture('9C8L2')).jpeg().toBuffer();
      await expect(worker.solve(jpeg, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

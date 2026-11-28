import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ChinaqingguanOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.gif`, import.meta.url));

describe('Rongtong International verify code OCR', () => {
  it('reads pictures the tracker serves, and refuses another geometry or format', async () => {
    const worker = new ChinaqingguanOcr();
    try {
      for (const answer of ['5823', '3766', '3572', '1581']) expect(await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toBe(answer);
      const wider = await sharp(picture('5823')).resize(70, 24, { fit: 'fill' }).gif().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const png = await sharp(picture('5823')).png().toBuffer();
      await expect(worker.solve(png, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MorelinkOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.jpg`, import.meta.url));

describe('MoreLink verify code OCR', () => {
  it('reads pictures the tracker serves, without regard to case, and refuses another geometry or format', async () => {
    const worker = new MorelinkOcr();
    try {
      // The tracker takes the code in either case, and the model does not always tell a letter's case.
      for (const answer of ['vhy5', 'tweh', 'fcgp', 'bc3m']) expect((await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toLowerCase()).toBe(answer);
      const wider = await sharp(picture('vhy5')).resize(160, 41, { fit: 'fill' }).jpeg().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const png = await sharp(picture('vhy5')).png().toBuffer();
      await expect(worker.solve(png, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

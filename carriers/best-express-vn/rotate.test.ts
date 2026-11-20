import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { BestRotate } from './rotate.js';
import { answerFor, picturePixels, readLibrary, rings } from './rotate-worker.mjs';

const picture = readFileSync(new URL('./fixtures/rotate-232.jpg', import.meta.url));
const library = readLibrary(JSON.parse(readFileSync(new URL('./rotate-library.json', import.meta.url), 'utf8')));
const apart = (a: number, b: number) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
/** The picture turned further clockwise, cut back to its 150 pixels. */
const turned = async (degrees: number) => {
  const { data, info } = await sharp(picture).rotate(degrees, { background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true });
  const left = Math.floor((info.width - 150) / 2), top = Math.floor((info.height - 150) / 2);
  return sharp(data, { raw: info }).extract({ left, top, width: 150, height: 150 }).jpeg({ quality: 92 }).toBuffer();
};

describe('BEST rotate pictures', () => {
  it('answers a picture the service accepted, and the same picture turned further', async () => {
    expect(apart(answerFor(rings(await picturePixels(picture)), library)!, 232)).toBeLessThan(3);
    for (const extra of [30, 95, 200]) {
      expect(apart(answerFor(rings(await picturePixels(await turned(extra))), library)!, 232 + extra), String(extra)).toBeLessThan(4);
    }
  });

  it('answers nothing for a picture it does not know', async () => {
    const noise = await sharp(Buffer.from(Array.from({ length: 150 * 150 * 3 }, (_, index) => (index * 7919) % 251)), { raw: { width: 150, height: 150, channels: 3 } })
      .jpeg().toBuffer();
    expect(answerFor(rings(await picturePixels(noise)), library)).toBeNull();
  });

  it('reads pictures in a worker, and refuses another format or size', async () => {
    const worker = new BestRotate('BEST Express Vietnam');
    try {
      expect(apart(Number(await worker.solve(picture, AbortSignal.timeout(15_000))), 232)).toBeLessThan(3);
      const wider = await sharp(picture).resize(151, 150, { fit: 'fill' }).jpeg().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const png = await sharp(picture).png().toBuffer();
      await expect(worker.solve(png, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

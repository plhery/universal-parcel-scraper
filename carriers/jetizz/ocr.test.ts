import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import characters from '../../core/transport/text-captcha-model/characters.json' with { type: 'json' };
import { decodeJetizzLogits } from './ocr-worker.mjs';
import { JetizzOcr } from './ocr.js';

const picture = (answer: string) => readFileSync(new URL(`./fixtures/captcha-${answer}.jpg`, import.meta.url));
const label = (character: string) => Number(Object.entries(characters).find(([, value]) => value === character)![0]);

describe('Jetizz captcha OCR', () => {
  it('reads each step as a capital letter or digit, a small letter and its capital together', () => {
    const steps = 5, classes = 8210;
    const data = new Float32Array(steps * classes).fill(-10);
    const mark = (step: number, character: string, score: number) => { data[step * classes + label(character)] = score; };
    mark(0, 'S', 5);
    // A capital E scored below an unrelated label still reads as E with its small letter's weight.
    mark(1, 'E', 3); mark(1, 'e', 3); mark(1, 'X', 3.5);
    mark(2, '', 5);
    mark(3, 'c', 5);
    mark(4, '6', 5);
    expect(decodeJetizzLogits(data, [steps, 1, classes])).toBe('SEC6');
    expect(() => decodeJetizzLogits(data, [steps, classes])).toThrow('invalid tensor');
    data[0] = Number.NaN;
    expect(() => decodeJetizzLogits(data, [steps, 1, classes])).toThrow('invalid score');
  });

  it('reads pictures the tracker accepted, and refuses another geometry', async () => {
    const worker = new JetizzOcr();
    try {
      for (const answer of ['SEC6', 'HBJS']) expect(await worker.solve(picture(answer), AbortSignal.timeout(15_000))).toBe(answer);
      const wider = await sharp(picture('SEC6')).resize(96, 34, { fit: 'fill' }).jpeg().toBuffer();
      await expect(worker.solve(wider, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
      const png = await sharp(picture('SEC6')).png().toBuffer();
      await expect(worker.solve(png, AbortSignal.timeout(5_000))).rejects.toMatchObject({ kind: 'challenge' });
    } finally { await worker.close(); }
  }, 30_000);
});

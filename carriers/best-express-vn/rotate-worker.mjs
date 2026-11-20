import { readFile } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';

// BEST's rotate pictures are 150-pixel round JPEGs turned by a random angle.
export const SIZE = 150;
const MAX_BYTES = 40_000;
// Rings sampled around the centre, and the samples taken on each.
export const RINGS = [12, 19, 26, 33, 40, 47, 54, 61, 68];
export const STEPS = 120;
const DEGREES = 360 / STEPS;
// Two pictures of one base correlate above 0.85 once aligned; different bases stay below
// 0.75 unless their colours differ, which the ring colours catch first.
const MATCH = 0.85;
const MARGIN = 0.05;
const COLOUR = 14;

// Each sample averages a patch of the ring: points along its arc and across the ring's band, so a
// picture resampled at another angle keeps its samples.
const ARC = 6;
const BAND = [-2, -1, 0, 1, 2];

/** The picture's rings: their mean colours, which no rotation changes, and each ring's
 * normalised grey levels clockwise on screen from the right. */
export function rings(pixels) {
  const centre = (SIZE - 1) / 2;
  const at = (x, y, channel) => pixels[(y * SIZE + x) * 3 + channel];
  const colour = new Float64Array(RINGS.length * 3), grey = new Float64Array(RINGS.length * STEPS);
  const value = new Float64Array(3);
  for (const [ring, radius] of RINGS.entries()) {
    for (let step = 0; step < STEPS; step++) {
      value.fill(0);
      for (let part = 0; part < ARC; part++) {
        const angle = ((step - 0.5 + (part + 0.5) / ARC) / STEPS) * 2 * Math.PI;
        for (const offset of BAND) {
          const x = centre + (radius + offset) * Math.cos(angle), y = centre + (radius + offset) * Math.sin(angle);
          const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
          for (let channel = 0; channel < 3; channel++) {
            value[channel] += at(x0, y0, channel) * (1 - fx) * (1 - fy) + at(x0 + 1, y0, channel) * fx * (1 - fy)
              + at(x0, y0 + 1, channel) * (1 - fx) * fy + at(x0 + 1, y0 + 1, channel) * fx * fy;
          }
        }
      }
      for (let channel = 0; channel < 3; channel++) value[channel] /= ARC * BAND.length;
      for (let channel = 0; channel < 3; channel++) colour[ring * 3 + channel] += value[channel] / STEPS;
      grey[ring * STEPS + step] = 0.299 * value[0] + 0.587 * value[1] + 0.114 * value[2];
    }
    const row = grey.subarray(ring * STEPS, (ring + 1) * STEPS);
    const mean = row.reduce((sum, value) => sum + value, 0) / STEPS;
    const spread = Math.sqrt(row.reduce((sum, value) => sum + (value - mean) ** 2, 0) / STEPS) || 1;
    for (let step = 0; step < STEPS; step++) row[step] = (row[step] - mean) / spread;
  }
  return { colour, grey };
}

/** The clockwise turn, in degrees, that takes `turned` onto `upright`, and how well they then agree. */
export function alignment(upright, turned) {
  const scores = new Float64Array(STEPS);
  for (let shift = 0; shift < STEPS; shift++) {
    let sum = 0;
    for (let ring = 0; ring < RINGS.length; ring++) {
      const base = ring * STEPS;
      for (let step = 0; step < STEPS; step++) sum += upright[base + step] * turned[base + ((step - shift + STEPS) % STEPS)];
    }
    scores[shift] = sum / (RINGS.length * STEPS);
  }
  let best = 0;
  for (let shift = 1; shift < STEPS; shift++) if (scores[shift] > scores[best]) best = shift;
  // The peak between samples, from the parabola through it and its neighbours.
  const before = scores[(best - 1 + STEPS) % STEPS], after = scores[(best + 1) % STEPS], curve = before - 2 * scores[best] + after;
  const offset = curve < 0 ? Math.max(-0.5, Math.min(0.5, (before - after) / (2 * curve))) : 0;
  return { degrees: (((best + offset) * DEGREES) % 360 + 360) % 360, score: scores[best] };
}

const unpack = (text, length, scale) => {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== length) throw new Error('BEST rotate library is invalid');
  return Float64Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length), value => value / scale);
};

/** Bases from the library: ring colours and upright grey rings, packed as base64 bytes. */
export function readLibrary(json) {
  if (json?.rings?.join() !== RINGS.join() || json.steps !== STEPS || !Array.isArray(json.bases)) throw new Error('BEST rotate library is invalid');
  return json.bases.map(([colour, grey]) => ({
    colour: Float64Array.from(Buffer.from(colour, 'base64')),
    grey: unpack(grey, RINGS.length * STEPS, json.scale),
  }));
}

const apart = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);

/** The answer BEST expects for a picture: how far clockwise it is turned from upright. Null when
 * no base matches, or when bases that match about as well disagree. The pool holds variants of
 * some pictures, retinted or recropped, which agree on their upright. */
export function answerFor(picture, library) {
  const matches = [];
  for (const base of library) {
    let distance = 0;
    for (let index = 0; index < base.colour.length; index++) distance += (base.colour[index] - picture.colour[index]) ** 2;
    if (Math.sqrt(distance / base.colour.length) > COLOUR) continue;
    const match = alignment(base.grey, picture.grey);
    if (match.score >= MATCH - MARGIN) matches.push({ score: match.score, answer: (360 - match.degrees) % 360 });
  }
  matches.sort((a, b) => b.score - a.score);
  const [best] = matches;
  if (!best || best.score < MATCH) return null;
  if (matches.some(other => other.score > best.score - MARGIN && apart(other.answer, best.answer) > 7)) return null;
  return best.answer;
}

export async function picturePixels(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('unsupported-image');
  try {
    const image = sharp(bytes, { limitInputPixels: SIZE * SIZE, pages: 1, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'jpeg' || metadata.width !== SIZE || metadata.height !== SIZE || (metadata.pages ?? 1) !== 1) throw new Error('unsupported-image');
    const pixels = await image.flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
    if (pixels.length !== SIZE * SIZE * 3) throw new Error('unsupported-image');
    return pixels;
  } catch { throw new Error('unsupported-image'); }
}

let library;
async function solve(bytes) {
  const picture = rings(await picturePixels(bytes));
  library ??= readLibrary(JSON.parse(await readFile(new URL('./rotate-library.json', import.meta.url), 'utf8')));
  const answer = answerFor(picture, library);
  return answer === null ? '' : answer.toFixed(3);
}

parentPort?.on('message', async ({ id, bytes }) => {
  try {
    parentPort.postMessage({ id, answer: await solve(bytes) });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message === 'unsupported-image' ? 'unsupported-image' : 'inference-failed' });
  }
});

// Builds carriers/best-express-vn/rotate-library.json from BEST rotate pictures and their labels.
// Usage: node scripts/best-rotate-library.mjs <pictures-dir> <labels.json>
// labels.json maps a picture's file name to the clockwise turn, in degrees, that makes it
// upright, for one picture of each base; null entries are left out.
import { readFileSync, writeFileSync } from 'node:fs';
import { picturePixels, RINGS, rings, STEPS } from '../carriers/best-express-vn/rotate-worker.mjs';

const SCALE = 32;
const [directory, labelsPath] = process.argv.slice(2);
if (!directory || !labelsPath) throw new Error('Usage: node scripts/best-rotate-library.mjs <pictures-dir> <labels.json>');
const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
const bases = [];
for (const [file, upright] of Object.entries(labels).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
  if (typeof upright !== 'number') continue;
  const { colour, grey } = rings(await picturePixels(readFileSync(`${directory}/${file}`)));
  // Turning a picture clockwise moves each ring sample clockwise: upright(s) = picture(s - turn).
  const shift = (upright / 360) * STEPS;
  const turned = new Int8Array(RINGS.length * STEPS);
  for (let ring = 0; ring < RINGS.length; ring++) {
    for (let step = 0; step < STEPS; step++) {
      const from = step - shift, low = Math.floor(from), weight = from - low;
      const sample = (index) => grey[ring * STEPS + ((index % STEPS) + STEPS) % STEPS];
      const value = sample(low) * (1 - weight) + sample(low + 1) * weight;
      turned[ring * STEPS + step] = Math.max(-127, Math.min(127, Math.round(value * SCALE)));
    }
  }
  bases.push([Buffer.from(Uint8Array.from(colour, Math.round)).toString('base64'), Buffer.from(turned.buffer).toString('base64')]);
}
writeFileSync(new URL('../carriers/best-express-vn/rotate-library.json', import.meta.url),
  `${JSON.stringify({ rings: RINGS, steps: STEPS, scale: SCALE, bases })}\n`);
console.log(`${bases.length} bases`);

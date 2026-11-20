import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web';
import sharp from 'sharp';
import characters from '../../core/transport/text-captcha-model/characters.json' with { type: 'json' };

// The tracker's BotDetect pictures: four capital letters or digits in one of many styles, on a 95x34 JPEG.
const WIDTH = 95;
const HEIGHT = 34;
const CLASSES = 8210;
// The model's own input height; the width keeps the picture's proportions, as ddddocr feeds it.
const INPUT_HEIGHT = 64;
const INPUT_WIDTH = Math.round(WIDTH * INPUT_HEIGHT / HEIGHT);
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
let session;

// The model's labels for the blank and each capital letter or digit; a small letter counts as its capital.
const GROUPS = (() => {
  const groups = new Map();
  for (const [index, character] of Object.entries(characters)) {
    const key = character.toUpperCase();
    groups.set(key, [...(groups.get(key) ?? []), Number(index)]);
  }
  return [...groups];
})();

/** The model's CTC steps read as capital letters and digits, each step's likeliest label among them. */
export function decodeJetizzLogits(data, dims) {
  if (dims.length !== 3 || dims[0] < 1 || dims[0] > 64 || dims[1] !== 1 || dims[2] !== CLASSES || data.length !== dims[0] * CLASSES) {
    throw new Error('Jetizz OCR returned an invalid tensor');
  }
  let previous = null, answer = '';
  for (let step = 0; step < dims[0]; step++) {
    const row = data.subarray(step * CLASSES, (step + 1) * CLASSES);
    let top = -Infinity;
    for (const value of row) {
      if (!Number.isFinite(value)) throw new Error('Jetizz OCR returned an invalid score');
      if (value > top) top = value;
    }
    let best = null, weight = -1;
    for (const [label, indexes] of GROUPS) {
      let sum = 0;
      for (const index of indexes) sum += Math.exp(row[index] - top);
      if (sum > weight) { weight = sum; best = label; }
    }
    if (best !== previous && best !== '') answer += best;
    previous = best;
  }
  return answer;
}

async function solve(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 20_000) throw new Error('unsupported-image');
  let pixels;
  try {
    const image = sharp(bytes, { limitInputPixels: WIDTH * HEIGHT, pages: 1, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'jpeg' || metadata.width !== WIDTH || metadata.height !== HEIGHT || (metadata.pages ?? 1) !== 1) throw new Error('unsupported-image');
    pixels = await image.flatten({ background: '#ffffff' }).resize(INPUT_WIDTH, INPUT_HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
      .greyscale().raw().toBuffer();
    if (pixels.length !== INPUT_WIDTH * INPUT_HEIGHT) throw new Error('unsupported-image');
  } catch { throw new Error('unsupported-image'); }
  if (!session) {
    const model = await readFile(new URL('../../core/transport/text-captcha-model/captcha.onnx', import.meta.url));
    session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  }
  // Grey levels from 0 to 1 read these pictures better than the -1 to 1 the other carriers' profiles use.
  const input = new ort.Tensor('float32', Float32Array.from(pixels, value => value / 255), [1, 1, INPUT_HEIGHT, INPUT_WIDTH]);
  const output = (await session.run({ input1: input }))['387'];
  if (!output || output.type !== 'float32') throw new Error('Jetizz OCR returned an invalid output');
  return decodeJetizzLogits(output.data, output.dims);
}

parentPort?.on('message', async ({ id, bytes }) => {
  try {
    parentPort.postMessage({ id, answer: await solve(bytes) });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message === 'unsupported-image' ? 'unsupported-image' : 'inference-failed' });
  }
});

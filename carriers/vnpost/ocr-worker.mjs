import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web';
import sharp from 'sharp';

// The tracker's pictures: four characters drawn by mews/captcha on a 100x40 JPEG.
const WIDTH = 100;
const HEIGHT = 40;
const LENGTH = 4;
export const VNPOST_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
let session;

/** The likeliest character at each of the four places. */
export function decodeVnpostLogits(data, dims) {
  const classes = VNPOST_CHARACTERS.length;
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== LENGTH || dims[2] !== classes || data.length !== LENGTH * classes) {
    throw new Error('VNPost OCR returned an invalid tensor');
  }
  let answer = '';
  for (let position = 0; position < LENGTH; position += 1) {
    const row = data.subarray(position * classes, (position + 1) * classes);
    let best = 0;
    for (let index = 0; index < classes; index += 1) {
      if (!Number.isFinite(row[index])) throw new Error('VNPost OCR returned an invalid score');
      if (row[index] > row[best]) best = index;
    }
    answer += VNPOST_CHARACTERS[best];
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
    pixels = await image.removeAlpha().toColourspace('srgb').raw().toBuffer();
    if (pixels.length !== WIDTH * HEIGHT * 3) throw new Error('unsupported-image');
  } catch { throw new Error('unsupported-image'); }
  // The model takes the picture's channels apart, as values from 0 to 255.
  const input = new Float32Array(3 * WIDTH * HEIGHT);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    for (let channel = 0; channel < 3; channel += 1) input[channel * WIDTH * HEIGHT + pixel] = pixels[pixel * 3 + channel];
  }
  if (!session) {
    const model = await readFile(new URL('./model/captcha.onnx', import.meta.url));
    session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  }
  const output = (await session.run({ image: new ort.Tensor('float32', input, [1, 3, HEIGHT, WIDTH]) })).logits;
  if (!output || output.type !== 'float32') throw new Error('VNPost OCR returned an invalid output');
  return decodeVnpostLogits(output.data, output.dims);
}

parentPort?.on('message', async ({ id, bytes }) => {
  try {
    parentPort.postMessage({ id, answer: await solve(bytes) });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message === 'unsupported-image' ? 'unsupported-image' : 'inference-failed' });
  }
});

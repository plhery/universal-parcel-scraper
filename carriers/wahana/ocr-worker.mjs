import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import * as ort from 'onnxruntime-web';
import characters from '../../core/transport/text-captcha-model/characters.json' with { type: 'json' };
import { decodeTextCaptchaLogits } from '../../core/transport/text-captcha-decode.mjs';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
let session;

async function solve(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 100_000) throw new Error('unsupported-image');
  const image = sharp(bytes, { limitInputPixels: 30_000, pages: 1, failOn: 'warning' });
  const metadata = await image.metadata().catch(() => { throw new Error('unsupported-image'); });
  if (metadata.format !== 'png' || metadata.height !== 150 || !metadata.width || metadata.width < 20
    || metadata.width > 200 || (metadata.pages ?? 1) !== 1) throw new Error('unsupported-image');
  // Each choice is one character. Stretching it across the model's four-character input loses its shape.
  const pixels = await image.flatten({ background: '#fff' }).greyscale()
    .resize(256, 64, { fit: 'contain', background: '#fff' }).raw().toBuffer();
  if (pixels.length !== 256 * 64) throw new Error('unsupported-image');
  session ??= await ort.InferenceSession.create(new Uint8Array(await readFile(
    new URL('../../core/transport/text-captcha-model/captcha.onnx', import.meta.url))),
  { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  const input = new ort.Tensor('float32', Float32Array.from(pixels, value => value / 127.5 - 1), [1, 1, 64, 256]);
  const output = (await session.run({ input1: input }))['387'];
  if (!output || output.type !== 'float32') throw new Error('inference-failed');
  const answer = decodeTextCaptchaLogits(output.data, output.dims, characters);
  return /^[A-Za-z0-9]$/.test(answer) ? answer.toUpperCase() : '';
}

parentPort?.on('message', async ({ id, bytes }) => {
  try { parentPort.postMessage({ id, answer: await solve(bytes) }); }
  catch (error) { parentPort.postMessage({ id, error: error?.message === 'unsupported-image' ? 'unsupported-image' : 'inference-failed' }); }
});

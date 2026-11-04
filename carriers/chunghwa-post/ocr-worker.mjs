import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web';
import sharp from 'sharp';
import characters from '../../core/transport/text-captcha-model/characters.json' with { type: 'json' };
import { decodeTextCaptchaLogits } from '../../core/transport/text-captcha-decode.mjs';
import { decodeChunghwaDigits, removeChunghwaGrid } from './captcha.mjs';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
let session;

async function solve(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 50_000) throw new Error('unsupported-image');
  const image = sharp(bytes, { limitInputPixels: 10_000, pages: 1, failOn: 'warning' });
  const metadata = await image.metadata().catch(() => { throw new Error('unsupported-image'); });
  if (metadata.format !== 'jpeg' || metadata.width !== 162 || metadata.height !== 54 || (metadata.pages ?? 1) !== 1) {
    throw new Error('unsupported-image');
  }
  const pixels = await image.flatten({ background: '#ffffff' }).greyscale().raw().toBuffer();
  const cleared = removeChunghwaGrid(pixels, 162, 54);
  if (!session) session = await ort.InferenceSession.create(new Uint8Array(await readFile(
    new URL('../../core/transport/text-captcha-model/captcha.onnx', import.meta.url))),
  { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  let best = { answer: '', confidence: -Infinity };
  // Preserve the original four-digit reading: removing a rule can damage a crossing digit.
  for (const [source, width] of [[pixels, 256], [cleared, 192], [pixels, 192]]) {
    const resized = source === pixels && width === 256
      ? await image.clone().resize(256, 64).raw().toBuffer()
      : await sharp(source, { raw: { width: 162, height: 54, channels: 1 } })
        .resize(width, 64, { fit: 'fill' }).greyscale().raw().toBuffer();
    const input = new ort.Tensor('float32', Float32Array.from(resized, value => value / 127.5 - 1), [1, 1, 64, width]);
    const output = (await session.run({ input1: input }))['387'];
    if (!output || output.type !== 'float32') throw new Error('Invalid OCR output');
    if (source === pixels && width === 256) {
      const original = decodeTextCaptchaLogits(output.data, output.dims);
      if (/^\d{4}$/.test(original)) return original;
    }
    const candidate = decodeChunghwaDigits(output.data, output.dims, characters);
    if (/^\d{4}$/.test(candidate.answer) && candidate.confidence > best.confidence) best = candidate;
  }
  return best.answer;
}

parentPort?.on('message', async ({ id, bytes }) => {
  try { parentPort.postMessage({ id, answer: await solve(bytes) }); }
  catch (error) { parentPort.postMessage({ id, error: error?.message === 'unsupported-image' ? 'unsupported-image' : 'inference-failed' }); }
});

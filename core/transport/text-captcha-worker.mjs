import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-web';
import sharp from 'sharp';
import characters from './text-captcha-model/characters.json' with { type: 'json' };
import arithmeticCharacters from './text-captcha-model/arithmetic-characters.json' with { type: 'json' };

const profiles = {
  'viettel-post': { width: 200, height: 50, format: 'png' },
  'chunghwa-post': { width: 162, height: 54, format: 'jpeg' },
  'ecms-express': { width: 200, height: 45, format: 'png', crop: { left: 0, top: 0, width: 145, height: 45 }, characters: arithmeticCharacters },
  // DTDC's letters reach the picture's sides, where the model drops them without a margin.
  dtdc: { width: 180, height: 60, format: 'png', margin: 20 },
  // PAD's and Yuxin's small pictures read best kept to their own proportions, as ddddocr feeds the model.
  padtf: { width: 70, height: 25, format: 'png', keepAspect: true },
  'yuxin-logistics': { width: 70, height: 26, format: 'jpeg', keepAspect: true },
  'hainan-airlines-cargo': { width: 58, height: 25, format: 'jpeg', keepAspect: true },
  // Rongtong's small GIF reads best kept to its proportions, without the grey frame drawn round it.
  chinaqingguan: { width: 50, height: 24, format: 'gif', crop: { left: 1, top: 1, width: 48, height: 22 }, keepAspect: true },
  'professional-couriers': { width: 160, height: 44, format: 'png' },
  sunspeedy: { width: 90, height: 30, format: 'png' },
  // MTCaptcha's photographic pictures run to tens of kilobytes. The text keeps to the middle, and the
  // model reads it best cut from the margins and stretched to its input.
  mtcaptcha: { width: 350, height: 100, format: 'gif', maxBytes: 200_000, crop: { left: 30, top: 10, width: 300, height: 80 }, fit: 'fill' },
};
const profile = profiles[workerData?.profile ?? 'viettel-post'];
// The model's input is 64 pixels high; most profiles stretch the picture to 256 wide.
const inputWidth = profile?.keepAspect ? Math.round(profile.width * 64 / profile.height) : 256;

ort.env.wasm.numThreads = 1;
// The original model's declared output shape is stale; its actual tensor is checked below.
ort.env.logLevel = 'error';
let session;

export { decodeTextCaptchaLogits } from './text-captcha-decode.mjs';
import { decodeTextCaptchaLogits } from './text-captcha-decode.mjs';

async function solve(bytes) {
  if (!profile || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > (profile.maxBytes ?? 50_000)) throw new Error('unsupported-image');
  const image = sharp(bytes, { limitInputPixels: profile.width * profile.height, pages: 1, failOn: 'warning' });
  const metadata = await image.metadata().catch(() => { throw new Error('unsupported-image'); });
  if (metadata.format !== profile.format || metadata.width !== profile.width || metadata.height !== profile.height || (metadata.pages ?? 1) !== 1) throw new Error('unsupported-image');
  // A crop drops what is no text, such as the equals sign in ECMS's fourth column.
  if (profile.crop) image.extract(profile.crop);
  // Sharp widens a picture after resizing it, so the margin is drawn first.
  const framed = profile.margin ? sharp(await image.flatten({ background: '#ffffff' })
    .extend({ left: profile.margin, right: profile.margin, background: '#ffffff' }).png().toBuffer()) : image;
  const fit = profile.keepAspect ? 'fill' : profile.fit;
  const pixels = await framed.flatten({ background: '#ffffff' }).greyscale().resize(inputWidth, 64, fit ? { fit } : undefined).raw().toBuffer();
  if (pixels.length !== inputWidth * 64) throw new Error('unsupported-image');
  if (!session) session = await ort.InferenceSession.create(new Uint8Array(await readFile(new URL('./text-captcha-model/captcha.onnx', import.meta.url))),
    { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  const input = new ort.Tensor('float32', Float32Array.from(pixels, value => value / 127.5 - 1), [1, 1, 64, inputWidth]);
  const output = (await session.run({ input1: input }))['387'];
  if (!output || output.type !== 'float32') throw new Error('Invalid OCR output');
  return decodeTextCaptchaLogits(output.data, output.dims, profile.characters ?? characters);
}

parentPort?.on('message', async ({ id, bytes }) => {
  try { parentPort.postMessage({ id, answer: await solve(bytes) }); }
  catch (error) { parentPort.postMessage({ id, error: error?.message === 'unsupported-image' ? 'unsupported-image' : 'inference-failed' }); }
});

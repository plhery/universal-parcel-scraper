import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.AGAEL_TRACKING_NUMBER;

it.skipIf(!number)('returns registration and route scans for the guide published by AGAEL', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events?.some(event => event.description === 'Registrado')).toBe(true);
  expect(result.events?.some(event => event.description === 'En ruta')).toBe(true);
}, 20_000);

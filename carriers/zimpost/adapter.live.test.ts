import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const tracker = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.ZIMPOST_TRACKING_NUMBER;

it.skipIf(!number)('reads the IPS events of an item Zimpost holds, each with an instant', async () => {
  const result = await tracker.track({ number: number! });
  expect(result.events!.length).toBeGreaterThan(0);
  // Every scan has IPS's event number, its English name and an instant with the offset IPS states.
  expect(result.events!.every(event => event.description && /^\d{1,4}$/.test(String(event.provider_code))
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
}, 30_000);

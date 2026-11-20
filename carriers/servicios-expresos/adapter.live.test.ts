import { expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const number = process.env.SERVICIOS_EXPRESOS_TRACKING_NUMBER;

it.skipIf(!number)('recognizes the published guide and its native delivery movement', async () => {
  const tracking = adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
  const result = await tracking.track({ number: number! });
  expect(result.status).toBe('delivered');
  expect(result.events).toContainEqual(expect.objectContaining({ description: 'ENTREGADO', stage: 'delivered' }));
}, 25_000);

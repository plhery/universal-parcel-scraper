import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const number = process.env.POSTNET_ZA_TRACKING_NUMBER;
const unknown = process.env.POSTNET_ZA_UNKNOWN_NUMBER;

describe('PostNet live retrieval', () => {
  it.skipIf(!number)('retrieves the dated events of the requested waybill', async () => {
    const result = await direct().track({ number: number! });
    const events = result.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.description && /\+02:00$/.test(String(event.time)))).toBe(true);
  }, 60_000);

  it.skipIf(!number)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(number!)).resolves.toMatchObject({ known: true });
  }, 60_000);

  it.skipIf(!unknown)('reads a made-up waybill as not found', async () => {
    await expect(direct().track({ number: unknown! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 60_000);
});

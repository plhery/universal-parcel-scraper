import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const number = (process.env.JADLOG_TRACKING_NUMBER ?? '').trim();
const unknown = (process.env.JADLOG_UNKNOWN_NUMBER ?? '').trim();
const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Jadlog live guest tracking', () => {
  it.runIf(Boolean(number))('returns the requested Brazilian parcel with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number, carrier: 'jadlog' });
    expect(answer).toMatchObject({ carrier: 'jadlog', source: 'jadlog' });
    expect(answer.attempts[0]).toMatchObject({ source: 'jadlog', kind: 'ok' });
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every milestone carries Geopost's own offset.
    expect(answer.result.events.every(event => /[+-]\d{2}:\d{2}$/.test(String(event.time)) && event.provider_code)).toBe(true);
    expect(answer.result.tracking_url).toBe('https://www.jadlog.com.br/jadlog/home');
  }, 60_000);

  it.runIf(Boolean(number))('recognizes the Brazilian parcel', async () => {
    await expect(direct().recognize!(number)).resolves.toEqual({ known: true });
  }, 30_000);

  it.runIf(Boolean(unknown))('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: unknown })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

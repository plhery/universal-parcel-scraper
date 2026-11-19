import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Domex live retrieval', () => {
  it.skipIf(!process.env.DOMEX_TRACKING_NUMBER)('retrieves the history of the requested waybill with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: process.env.DOMEX_TRACKING_NUMBER!, carrier: 'domex' });
    expect(answer).toMatchObject({ carrier: 'domex', source: 'domex' });
    expect(answer.attempts[0]).toMatchObject({ source: 'domex', kind: 'ok' });
    expect(answer.result.current_stage).toBeTruthy();
    expect(answer.result.events.length).toBeGreaterThan(0);
    // Every scan has its wording and an instant, including the source seconds.
    expect(answer.result.events.every((event) => event.description && event.local_time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(event.time)))).toBe(true);
    expect(answer.result.last_update).toBe(answer.result.events[0]!.time);
    // A branch is a place, not part of the wording, and nobody is named.
    expect(answer.result.events.every((event) => !event.location || !/ By /.test(event.description ?? ''))).toBe(true);
    expect(answer.result.receiver_name ?? null).toBeNull();
    expect(answer.result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.DOMEX_TRACKING_NUMBER)('recognizes the requested waybill', async () => {
    await expect(direct().recognize!(process.env.DOMEX_TRACKING_NUMBER!)).resolves.toMatchObject({ known: true });
  });

  it.skipIf(!process.env.DOMEX_UNKNOWN_NUMBER)('keeps the generic unknown response inconclusive', async () => {
    await expect(direct().track({ number: process.env.DOMEX_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

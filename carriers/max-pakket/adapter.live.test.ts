import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter } from './adapter.js';
import numbers from './numbers.json' with { type: 'json' };

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The delivered public sample and its archived track and trace link, unless another code and link are given.
const SAMPLE = numbers.records[0]!;
const NUMBER = process.env.MAX_PAKKET_TRACKING_NUMBER ?? SAMPLE.number;
const LINK = process.env.MAX_PAKKET_TRACKING_URL ?? SAMPLE.source.url.replace(/^https:\/\/web\.archive\.org\/web\/\d+\//, '');
// An invented code, with an order number the app holds no order under for it.
const UNKNOWN = 'MXTT00000000000000AB';

describe('MAX Pakket live retrieval', () => {
  it('retrieves the order the track and trace link names with providers disabled', async () => {
    const answer = await createTracker({ providers: [] }).track({ number: NUMBER, carrier: 'max-pakket', trackingUrl: LINK });
    expect(answer).toMatchObject({ carrier: 'max-pakket', source: 'max-pakket' });
    expect(answer.attempts[0]).toMatchObject({ source: 'max-pakket', kind: 'ok' });
    const { result } = answer;
    expect(result.last_status_text).toEqual(expect.any(String));
    for (const event of result.events) expect(event.time ?? event.local_time).toEqual(expect.any(String));
    if (!process.env.MAX_PAKKET_TRACKING_NUMBER) {
      expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Succesvol afgeleverd', delivered_at: '2025-10-09T16:08:21+02:00' });
    }
  }, 45_000);

  it('reads a code and order number the app does not know as not found', async () => {
    const link = `https://emens.mendrix.cloud/TrackAndTrace/tnt?Tracecode=${UNKNOWN}&OrderId=1`;
    await expect(direct().track({ number: UNKNOWN, trackingUrl: link })).rejects.toMatchObject({ kind: 'not_found' });
  }, 45_000);
});

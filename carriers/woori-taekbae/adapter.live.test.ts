import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';

const direct = () => adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// A waybill whose history the tracker still keeps: it drops the scans of older shipments.
const NUMBER = process.env.WOORI_TAEKBAE_TRACKING_NUMBER;

describe('Woori Taekbae live retrieval', () => {
  it.skipIf(!NUMBER)('retrieves the requested shipment', async () => {
    const result = await direct().track({ number: NUMBER! });
    expect(result.events!.length).toBeGreaterThan(0);
    // Every scan has its step and code and keeps its wall clock without a zone, none after the lookup on Seoul's clock.
    const now = DateTime.now().setZone('Asia/Seoul').toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(result.events!.every((event) => event.description && /^\w+$/.test(event.provider_code ?? '') && event.time === undefined
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(event.local_time ?? '') && event.local_time! <= now)).toBe(true);
    expect(result.last_update_local).toBe(result.events![0]!.local_time);
    expect(result.status).not.toBe('unknown');
    // No phone number, masked name or customer field comes through.
    expect(JSON.stringify(result)).not.toMatch(/\d{9,}|\*|기사/);
    expect(result.receiver_name ?? null).toBeNull();
    expect(result.receiver_address ?? null).toBeNull();
    expect(result.sender_name ?? null).toBeNull();
  }, 45_000);

  it.skipIf(!process.env.WOORI_TAEKBAE_UNKNOWN_NUMBER)('reads an unknown number as not found', async () => {
    await expect(direct().track({ number: process.env.WOORI_TAEKBAE_UNKNOWN_NUMBER! })).rejects.toMatchObject({ kind: 'not_found' });
  }, 30_000);
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseMteXpress } from './parser.js';

const found: { shipments: Record<string, unknown>[] } = JSON.parse(readFileSync(new URL('./fixtures/found.json', import.meta.url), 'utf8'));
const number = 'UAMTDR3FB';

describe('MTE Xpress', () => {
  it('reads the shipment-level scans and retains the stated clock', () => {
    const result = parseMteXpress(found, number);
    expect(result.events).toHaveLength(10);
    expect(result.current_stage).toBe('delivered');
    expect(result.delivered_at).toBe('2026-04-10T09:52:18.882Z');
  });

  it('requires both the whole reference and the correct tenant', () => {
    expect(() => parseMteXpress(found, 'ZZZZZZZZZ')).toThrow();
    const other = { shipments: [{ ...found.shipments[0], provider_id: 9 }] };
    expect(() => parseMteXpress(other, number)).toThrow();
  });

  it('distinguishes the reference-bound negative from a generic 404', async () => {
    const track = (body: string) => adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {},
      fetcher: async () => new Response(body, { status: 404 }) }).track({ number: 'ZZZZZZZZZ' });
    await expect(track('could not find shipment or parcel with reference ZZZZZZZZZ')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(track('page not found')).rejects.toMatchObject({ kind: 'indeterminate' });
  });
});

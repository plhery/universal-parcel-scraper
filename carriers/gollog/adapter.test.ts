import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseGollogReply } from './parser.js';
import pickedUp from './fixtures/picked-up.json' with { type: 'json' };

const number = '12763027370';
const read = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');

describe('GOLLOG guest tracking', () => {
  it('keeps the public history and the pickup milestone distinct from final collection', () => {
    const result = parseGollogReply(read('picked-up'), number);
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2026-10-19T11:14:59Z',
      service_name: 'URGENTE', weight_kg: 2 });
    expect(result.events).toHaveLength(9);
    expect(result.events?.[0]).toMatchObject({ provider_code: 'DLV', location: 'VDC', stage: 'delivered' });
    expect(result.events?.[1]).toMatchObject({ provider_code: 'OND', stage: 'ready_for_pickup' });
    expect(result.events?.at(-1)).toMatchObject({ provider_code: 'RCS', location: 'PNZ', stage: 'accepted' });
  });

  it('reads the same release code as out for delivery on a home-delivery shipment', () => {
    const data = structuredClone(pickedUp);
    data.result[0]!.isHomeDelivery = true;
    expect(parseGollogReply(JSON.stringify(data), number).events?.[1]?.stage).toBe('out_for_delivery');
  });

  it('distinguishes absence, another identity and invalid replies', () => {
    expect(() => parseGollogReply(read('unknown'), '12799000007')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGollogReply(read('unknown'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGollogReply('<html><title>Just a moment…</title></html>', number)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseGollogReply('{"success":true,"result":[]}', number)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('sends a complete waybill through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(read('picked-up')));
    const tracker = adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null,
      browserExecutablePath: null, userAgent: 'Test/1.0' });
    await expect(tracker.track({ number: '127-6302 7370' })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://servicos.gollog.com.br/api/services/app/Tracking/GetAllByCodes?values=${number}`,
      expect.objectContaining({ redirect: 'manual', signal: expect.any(AbortSignal) }));
  });
});

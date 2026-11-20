import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InvalidInputError, NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.json', import.meta.url), 'utf8');

describe('King Kong Express waybill tracking', () => {
  it('posts one whole waybill with the caller transport and reads the current delivery', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(found));
    const tracker = adapter({ fetcher, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {} });
    await expect(tracker.track({ number: '0000000000' })).rejects.toThrow(InvalidInputError);
    expect(fetcher).not.toHaveBeenCalled();
    const result = await tracker.track({ number: '2032581837' });
    expect(fetcher).toHaveBeenCalledWith('https://www.kke.com.hk/home/index/quecode', expect.objectContaining({
      method: 'POST', body: new URLSearchParams({ code: '2032581837' }), signal: expect.any(AbortSignal),
    }));
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2023-04-22T09:53:45' });
    expect(result.events).toHaveLength(6);
  });

  it('requires the explicit empty envelope for absence', () => {
    expect(() => parseTracking(missing)).toThrow(NotFoundError);
    expect(() => parseTracking('{"status":1,"msg":"ok","data":{}}')).toThrow(/unexpected/i);
  });
});

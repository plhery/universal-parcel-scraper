import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const found = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');

describe('INTRAS house bill tracking', () => {
  it('keeps the undated delivery badge and the dated customs history distinct', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(found));
    const result = await adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher }).track({ number: '509632781115' });
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: '배송완료', last_update_local: '2026-08-14T10:47:03' });
    expect(result.events).toHaveLength(10);
    expect(result.events?.[0]).toMatchObject({ description: '반출신고', location: '용당세관구내지정장치장' });
    expect(result.delivered_at).toBeUndefined();
  });

  it('recognizes only a shipment-specific 404 and requires a matching house bill', () => {
    expect(() => parseTracking(missing, '509699999999', 404)).toThrow(NotFoundError);
    expect(() => parseTracking(missing, '509699999998', 404)).toThrow(/missing INTRAS/i);
    expect(() => parseTracking(found, '509699999999', 200)).toThrow(/another house bill/i);
  });
});

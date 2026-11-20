import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseTracking } from './parser.js';

const delivered = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/missing.html', import.meta.url), 'utf8');

describe('BIZ Courier Track iT', () => {
  it('reads the exact result row and tracks its dated history', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(delivered));
    const result = await adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher }).track({ number: 'SWS43517108' });
    expect(result).toMatchObject({ current_stage: 'delivered', last_update: '2020-07-22T08:51:10Z' });
    expect(result.events).toHaveLength(9);
    expect(result.events).toContainEqual(expect.objectContaining({ provider_code: 'INDEL', stage: 'out_for_delivery' }));
    expect(result.events).toContainEqual(expect.objectContaining({ provider_code: 'ONTOU', stage: 'in_transit' }));
  });

  it('separates an explicit empty result from a mismatched shipment and malformed HTML', () => {
    expect(() => parseTracking(missing, 'SWS99999999')).toThrow(NotFoundError);
    expect(() => parseTracking(delivered, 'SWS4351710')).toThrow(/matching shipment/);
    expect(() => parseTracking('<html></html>', 'SWS43517108')).toThrow(/Missing Track iT results/);
  });
});

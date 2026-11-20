import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { parseDetails, parseReference } from './parser.js';

const grid = readFileSync(new URL('./fixtures/grid.txt', import.meta.url), 'utf8');
const missing = readFileSync(new URL('./fixtures/grid-unknown.txt', import.meta.url), 'utf8');
const detail = readFileSync(new URL('./fixtures/detail.txt', import.meta.url), 'utf8');
const houseBill = 'ANR10415172';
const shipmentRef = 'S610415172';
const reply = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/x-component' } });

describe('MyJAS public freight tracking', () => {
  it('resolves a house bill and reads completed milestones through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(grid)).mockResolvedValueOnce(reply(detail));
    const result = await adapter({ trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER, env: {}, fetcher, userAgent: 'adapter-test' }).track({ number: houseBill });
    expect(fetcher).toHaveBeenNthCalledWith(2, expect.stringContaining(`shipmentNumber=${houseBill}`),
      expect.objectContaining({ method: 'POST', body: JSON.stringify([shipmentRef]), signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ 'User-Agent': 'adapter-test' }) }));
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-11-19T08:51:00' });
    expect(result.events).toContainEqual(expect.objectContaining({ description: 'Delivered', stage: 'delivered' }));
    expect(result.events).not.toContainEqual(expect.objectContaining({ provider_code: 'CCR' }));
  });

  it('distinguishes an empty public grid from an invalid or unrelated reply', () => {
    expect(() => parseReference(missing, 'ANR99999999')).toThrow(NotFoundError);
    expect(() => parseReference('<html>Invalid</html>', houseBill)).toThrow(/search results/i);
    expect(() => parseReference(grid, houseBill.slice(0, -1))).toThrow(/whole shipment/i);
    expect(() => parseDetails(detail, { houseBill, shipmentRef: 'S999999999' })).toThrow(/another shipment/i);
  });
});

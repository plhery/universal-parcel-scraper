import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DIAMOND_LINE_TRACKING } from './adapter.js';
import { normalizeDiamondLineNumber, parseDiamondLine } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const delivered = fixture('delivered.json') as { shipment: Record<string, unknown>; history: Record<string, unknown>[] };
const number = '173007016';
const tracker = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The API answers a shipment with HTTP 500, and a number it does not hold with HTTP 404.
const reply = (body: unknown, status: number) => Response.json(body, { status });
const withHistory = (history: unknown[], shipment: Record<string, unknown> = {}) => ({
  shipment: { ...delivered.shipment, ...shipment }, history,
});

describe('Diamond Line PRO numbers', () => {
  it('takes the PRO number with spaces or hyphens', () => {
    expect(normalizeDiamondLineNumber(' 173-007 016 ')).toBe(number);
    expect(() => normalizeDiamondLineNumber('ABC173007016')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(() => normalizeDiamondLineNumber('12345')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
  });

  it('posts the PRO number to the tracking API as the widget does, and reads the HTTP 500 shipment', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(delivered, 500));
    const result = await tracker(fetcher).track({ number: '173 007 016' });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(DIAMOND_LINE_TRACKING);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ type: 'pro', number });
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: null, last_update_local: '2024-01-31', weight_kg: 58.967,
    });
    // The record names a scanned page, not a person, as the signatory.
    expect(result).not.toHaveProperty('signed_by');
  });

  it('reads the rows newest first on their wall clocks, a row without a time by its day', () => {
    const { events = [] } = parseDiamondLine(delivered, number);
    expect(events.map((event) => [event.local_time, event.description, event.location ?? null, event.stage])).toEqual([
      ['2024-01-31', 'Delivered', 'Clinton, WA', 'delivered'],
      ['2024-01-26T15:35:00', 'Delivered', 'Clinton, WA', 'delivered'],
      ['2024-01-26T02:20:00', 'Trailer Arrived', null, 'in_transit'],
      ['2024-01-26T01:26:00', 'Trailer Departed For Seattle', 'Vantage Meet Point', 'in_transit'],
      ['2024-01-25T19:21:00', 'Trailer Departed For Vantage Meet Point', 'Spokane', 'in_transit'],
      ['2024-01-25T15:12:00', 'Picked Up', 'Spokane, WA', 'accepted'],
      ['2024-01-25T13:16:00', 'Pickup Request Received', 'Customer Care Center', 'registered'],
    ]);
    expect(events.some((event) => event.time)).toBe(false);
  });

  it('stages every recorded wording by the map, a departure for any terminal included', () => {
    for (const entry of statuses.entries) {
      const wording = entry.wording.replace('{terminal}', 'Boise').toLowerCase();
      expect(statusMap.stage(null, wording)).toBe(entry.stage);
    }
    // Synthetic: a wording the map does not know falls to the shared rules or stays without a
    // stage, and the stage is the newest staged row's.
    const result = parseDiamondLine(withHistory([{ code: 'Synthetic note', date: '2024-01-26', time: '03:00', remarks: 'Seattle' },
      ...delivered.history.slice(2)]), number);
    expect(result.events?.[0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Synthetic note' });
  });

  it('keeps a person who signed, and the weight in kilograms', () => {
    const result = parseDiamondLine(withHistory(delivered.history, { received_by: 'J SMITH', weight: '1000' }), number);
    expect(result).toMatchObject({ signed_by: 'J SMITH', weight_kg: 453.592 });
  });

  it('reports a PRO number the API does not hold as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(fixture('not-found.json'), 404));
    await expect(tracker(fetcher).track({ number: '999999999' })).rejects.toMatchObject({ kind: 'not_found' });
    // The error names another number: not an answer about this one.
    expect(() => parseDiamondLine(fixture('not-found.json'), number)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a rate quote as no shipment, and a shipment without rows as listed', () => {
    // Synthetic: the record the API keeps for a rate quote, with the lifecycle the page badges.
    const quote = { shipment: { pro_number: '100000001', bol_number: 'QuoteNo: 100000001', lifecycle: 'Quote',
      status: '****** R A T E   Q U O T E   O N L Y !! *******' }, history: [] };
    expect(() => parseDiamondLine(quote, '100000001')).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'no_history' }));
    expect(() => parseDiamondLine(withHistory([], { lifecycle: 'Pending' }), number))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('requires the shipment asked before reading a history', () => {
    expect(() => parseDiamondLine(delivered, '173007017')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('does not take a failure, a changed reply or a verification page for a missing shipment', async () => {
    expect(() => parseDiamondLine({ code: 'internal_server_error', message: 'Error', data: { status: 500 } }, number))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseDiamondLine({ shipment: 'none' }, number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDiamondLine(withHistory('none' as never), number)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDiamondLine(withHistory([{ code: 'Picked Up', date: '01/25/2024', time: '15:12' }]), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDiamondLine(withHistory([{ code: 'Picked Up', date: '2024-02-30', time: '15:12' }]), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseDiamondLine(withHistory([{ code: 'Picked Up', date: '2024-01-25', time: '25:12' }]), number))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    const challenged = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><head><title>Just a moment...</title></head></html>', { status: 403 }));
    await expect(tracker(challenged).track({ number })).rejects.toMatchObject({ kind: 'challenge' });
    const down = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><body>Error</body></html>', { status: 503 }));
    await expect(tracker(down).track({ number })).rejects.toMatchObject({ kind: 'transport' });
    const page = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('<html><body>Track</body></html>', { status: 200 }));
    await expect(tracker(page).track({ number })).rejects.toMatchObject({ kind: 'schema' });
  });
});

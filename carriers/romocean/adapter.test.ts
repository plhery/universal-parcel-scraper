import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, ROMOCEAN_TRACKER, RomoceanTracker } from './adapter.js';
import { parseRomocean, romoceanBill, romoceanResult } from './parser.js';
import { romoceanStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Public samples in numbers.json.
const DELIVERED = 'VLCALG02550R';
const TRANSSHIPPED = 'BCNBJA02895R';
const CONTAINERS = 'LEICAS00911R';
const REFILED = 'SAGTUN02426R';
const REUSED = 'BCNCAS02907R';
const UNMOVED = 'VLCCAS02357R';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
/** A fetcher for the search: each bill's reply by its number, and the not-found reply for any other. */
const search = (replies: Record<string, string> = {}) => vi.fn<typeof fetch>(async (_url, init) => {
  const [bill] = (JSON.parse(String(init!.body)) as { searchMovementValueList: string[] }).searchMovementValueList;
  return reply(replies[bill!] ?? (bill && /^[A-Z]{6}\d{5}R$/.test(bill) && !bill.startsWith('ZZZ') ? fixture(`bill-${bill}`) : fixture('not-found')));
});
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const summary = (events: readonly Record<string, unknown>[]) => events.map(event => [event.local_time, event.provider_code, event.location, event.stage]);

describe('Romocean HTTP adapter', () => {
  it('searches a bill and reads its container’s moves on the ports’ wall clocks', async () => {
    const fetcher = search();
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new RomoceanTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' vlcalg-02550r ');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(ROMOCEAN_TRACKER);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { 'User-Agent': 'SyntheticHost/1.0', 'Content-Type': 'application/json', Origin: 'https://shippy.romeushipping.com' } });
    expect(JSON.parse(String(init!.body))).toEqual({ searchMovementType: 1, searchMovementValueList: [DELIVERED], paginationInfo: {
      page: 1, take: 100, countTotal: null, pageTotal: null, orderBy: 'containerCode', orderByDirection: 'd' } });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'ENTRADA CONTAINER VACIO DISPONIBLE', last_update: null, last_update_local: '2026-09-29T15:00', expected_delivery: null });
    expect(result).not.toHaveProperty('history_truncated');
    expect(summary(result.events!)).toEqual([
      ['2026-09-29T15:00', 'MTY', 'DZALG', 'delivered'],
      ['2026-09-29T10:00', 'T/C', 'DZALG', 'delivered'],
      ['2026-09-10T13:00', 'IMP', 'DZALG', 'in_transit'],
      ['2026-09-10T09:00', 'VSI', 'DZALG', 'in_transit'],
      ['2026-09-09T22:00', 'VSO', 'ESVLC', 'in_transit'],
      ['2026-09-09T21:00', 'EXP', 'ESVLC', 'in_transit'],
      ['2026-09-02T16:31', 'E/L', 'ESVLC', 'accepted'],
      ['2026-09-02T13:31', 'T/S', 'ESVLC', 'registered'],
    ]);
    expect(result.events!.map(event => event.description)).toContain('CARGA BUQUE LLENO DE EXPORTACION');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'romocean', step: 'direct', outcome: 'ok' }));
  });

  it('follows a transshipment and keeps a bill in transit until its container is collected', async () => {
    const result = await carrier(search()).track({ number: TRANSSHIPPED });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_update_local: '2026-11-03T23:00' });
    expect(summary(result.events!).slice(0, 3)).toEqual([
      ['2026-11-03T23:00', 'VSO', 'ESVLC', 'in_transit'],
      ['2026-11-03T22:00', 'TRE', 'ESVLC', 'in_transit'],
      ['2026-10-27T08:00', 'TRI', 'ESVLC', 'in_transit'],
    ]);
  });

  it('keeps a bill’s collection and empty return that come without a bill, and its containers’ shared sailing once', async () => {
    const result = await carrier(search()).track({ number: CONTAINERS });
    expect(result).toMatchObject({ current_stage: 'delivered', last_update_local: '2026-11-02T09:50' });
    expect(result.events!.filter(event => event.provider_code === 'T/C').map(event => event.local_time))
      .toEqual(['2026-11-02T07:50', '2026-11-02T07:33']);
    expect(result.events!.filter(event => event.provider_code === 'VSO').map(event => [event.local_time, event.location]))
      .toEqual([['2026-10-13T21:00', 'PTLEI']]);
    expect(result.events!.filter(event => event.provider_code === 'T/S')).toHaveLength(3);
    // One container still at the port holds the bill open.
    const [first, ...rest] = parseRomocean(fixture(`bill-${CONTAINERS}`), CONTAINERS).containers;
    const open = romoceanResult({ containers: [first!.filter(event => event.stage !== 'delivered'), ...rest], truncated: true });
    expect(open).toMatchObject({ current_stage: 'in_transit', last_status_text: 'ENTRADA CONTAINER VACIO DISPONIBLE', history_truncated: true });
  });

  it('keeps the moves between a bill’s own that the tracker filed under another bill, and leaves out the container’s earlier trips', async () => {
    const refiled = await carrier(search()).track({ number: REFILED });
    expect(refiled.events!.map(event => event.provider_code)).toEqual(['MTY', 'T/C', 'IMP', 'VSI', 'VSO', 'EXP', 'E/L', 'T/S']);
    const reused = await carrier(search()).track({ number: REUSED });
    expect(summary(reused.events!)).toEqual([
      ['2026-11-01T21:00', 'VSO', 'ESBCN', 'in_transit'],
      ['2026-11-01T20:00', 'EXP', 'ESBCN', 'in_transit'],
      ['2026-10-28T16:06', 'E/L', 'ESBCN', 'accepted'],
      ['2026-10-26T19:25', 'T/S', 'ESBCN', 'registered'],
    ]);
    expect(reused).toMatchObject({ current_stage: 'in_transit' });
  });

  it('reads a bill whose container holds only other bills’ moves as listed without history', async () => {
    await expect(carrier(search()).track({ number: UNMOVED })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('reads an empty search as not found, and a changed reply as a schema change', async () => {
    await expect(carrier(search()).track({ number: 'ZZZZZZ00000R' })).rejects.toMatchObject({ kind: 'not_found' });
    const answer = (body: string) => carrier(search({ [DELIVERED]: body })).track({ number: DELIVERED });
    await expect(answer('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer('{"Data":null}')).rejects.toMatchObject({ kind: 'schema' });
    const garbled = fixture(`bill-${DELIVERED}`).replace('"2026-09-29T15:00:00"', '"29/09/2026"');
    await expect(answer(garbled)).rejects.toMatchObject({ kind: 'schema' });
  });

  it('keeps a firewall, a rate limit and an outage apart from a missing bill', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: DELIVERED });
    await expect(answer(reply('<html><title>Access Denied</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(reply('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(reply('', { status: 302, headers: { Location: '/' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('retries once when the first search does not reach the portal', async () => {
    const fetcher = search();
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends a bill of lading only', () => {
    expect(romoceanBill(' leicas 00911r ')).toBe(CONTAINERS);
    for (const bad of ['TCNU4814504', 'LEICAS00911', 'LEICAS0091R', 'ABC123', '1'.repeat(70), '']) {
      expect(() => romoceanBill(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the moves statuses.json records', () => {
    for (const { code, wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'romocean', providerCode: code, description: wording }), code)
        .toEqual(stage ? { kind: 'mapped', stage } : { kind: 'intentional_gap', note: expect.any(String) });
      expect(romoceanStage(code)).toBe(stage ?? undefined);
    }
    expect(statusMapAnswer({ carrier: 'romocean', providerCode: 'XYZ', description: 'MOVIMIENTO' })).toEqual({ kind: 'unknown' });
  });
});

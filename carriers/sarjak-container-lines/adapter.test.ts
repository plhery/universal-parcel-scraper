import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SARJAK_TRACKING, SarjakTracker, sarjakTrackingUrl } from './adapter.js';
import { parseSarjakTracking, sarjakQuery, sarjakResult } from './parser.js';
import { sarjakStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples in numbers.json, each with a fixture cut from its reply.
const BILL = 'NSASOH73352158685';
const SAILING = 'SJKU4520620';
const RETURNED = 'SJKU5403932';
// Containers the samples' replies list beside them.
const BESIDE_SAILING = 'ACTU4511331';
const OPEN = 'MSDU6380839';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const page = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const steps = (events: readonly { local_time?: string; description?: string; location?: string; stage?: string }[] = []) =>
  events.map(event => [event.local_time, event.description, event.location, event.stage]);

describe('Sarjak Container Lines HTTP adapter', () => {
  it('asks iTrack for the number in base64 and reads the container’s milestones', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => page(fixture(BILL)));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new SarjakTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(` ${BILL.toLowerCase()} `);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${SARJAK_TRACKING}TlNBU09INzMzNTIxNTg2ODU=`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal), headers: { 'User-Agent': 'SyntheticHost/1.0' } });
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Return Empty', last_update: null, last_update_local: '2026-10-31', expected_delivery: null });
    expect(steps(result.events)).toEqual([
      ['2026-10-31', 'Return Empty', 'Sohar,OM', 'delivered'],
      ['2026-10-01', 'Reached Destination', 'Sohar,OM', 'in_transit'],
      ['2026-09-23', 'Sailing', 'Nhava Sheva,IN', 'in_transit'],
      ['2026-09-22', 'Gate In', 'Nhava Sheva,IN', 'accepted'],
      ['2026-09-16', 'Container Pickup', 'Bholenath Marine Engineering work & logistics', 'registered'],
    ]);
    expect(result).not.toHaveProperty('planned_events');
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sarjak-container-lines', step: 'direct', outcome: 'ok' }));
  });

  it('keeps the milestones still ahead apart from the ones done', async () => {
    const result = await carrier(vi.fn<typeof fetch>(async () => page(fixture(SAILING)))).track({ number: SAILING });
    expect(result).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Sailing', last_update_local: '2026-11-10' });
    expect(steps(result.events)).toEqual([
      ['2026-11-10', 'Sailing', 'Ennore,IN', 'in_transit'],
      ['2026-11-07', 'Gate In', 'Ennore,IN', 'accepted'],
      ['2026-11-01', 'Container Pickup', 'MADRAS CONTAINER TERMINAL', 'registered'],
    ]);
    expect(steps(result.planned_events)).toEqual([
      ['2026-12-23', 'Reached Destination', 'Alexandria,EG', 'in_transit'],
      ['2027-01-13', 'Return Empty', 'Alexandria,EG', 'delivered'],
    ]);
  });

  it('reads a booking’s containers, keeping their shared milestones once', () => {
    const booking = parseSarjakTracking(fixture(SAILING), sarjakQuery('ENR/ALY/160208'));
    expect(booking.map(item => item.number)).toEqual([BESIDE_SAILING, SAILING]);
    const result = sarjakResult(booking);
    expect(steps(result.events).map(([day, description]) => `${day} ${description}`))
      .toEqual(['2026-11-10 Sailing', '2026-11-07 Gate In', '2026-11-01 Container Pickup', '2026-10-29 Container Pickup']);
    expect(result.planned_events).toHaveLength(2);
    expect(parseSarjakTracking(fixture(SAILING), sarjakQuery('ENRALY96584160208'))).toHaveLength(2);
    expect(() => parseSarjakTracking(fixture(SAILING), sarjakQuery(BILL))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSarjakTracking(fixture(SAILING), sarjakQuery('NSA-SOH-158685'))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseSarjakTracking(fixture(SAILING), sarjakQuery(RETURNED))).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('lets a booking’s open container lead until every container is back', () => {
    expect(sarjakResult(parseSarjakTracking(fixture(RETURNED), sarjakQuery(RETURNED)))).toMatchObject({ current_stage: 'delivered' });
    const booking = sarjakResult(parseSarjakTracking(fixture(RETURNED), sarjakQuery('MUNALY34622155335')));
    expect(booking).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Return Empty' });
    expect(steps(booking.planned_events)).toEqual([['2026-09-02', 'Return Empty', 'Alexandria,EG', 'delivered']]);
    // A milestone with no place keeps none.
    expect(sarjakResult(parseSarjakTracking(fixture(RETURNED), sarjakQuery(OPEN))).events!.at(-1)).toEqual(
      { local_time: '2026-05-23', description: 'Container Pickup', stage: 'registered', stage_source: 'carrier_map' });
  });

  it('reads iTrack’s incorrect-reference answer as not found, and a changed page as a schema change', async () => {
    const answer = (body: string, number = BILL) => carrier(vi.fn<typeof fetch>(async () => page(body))).track({ number });
    await expect(answer(fixture('not-found'))).rejects.toMatchObject({ kind: 'not_found' });
    await expect(answer('<html>maintenance</html>')).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer(fixture(BILL).replace("<small class='Late'>", "<small class='Delayed'>"))).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer(fixture(BILL).replace('31 Oct, 2026 <br>', '2026-10-31 <br>'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(answer(fixture(BILL).replace('<h4>SEGU7605266 - ', '<h4>SEGU760526 - '))).rejects.toMatchObject({ kind: 'schema' });
    // A booking whose milestones have all still to happen has no history yet.
    const ahead = fixture(BILL).replace(/<small class='(?:OnTime|Late)'>/g, "<small class='Forecast'>");
    await expect(answer(ahead)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('keeps a firewall, a rate limit and a moved page apart from a missing booking', async () => {
    const answer = (response: Response) => carrier(vi.fn<typeof fetch>(async () => response)).track({ number: BILL });
    await expect(answer(page('<html><title>Just a moment...</title></html>', { status: 403 }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(answer(page('', { status: 429 }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(answer(page('', { status: 302, headers: { Location: 'https://sarjak.com/' } }))).rejects.toMatchObject({ kind: 'transport' });
  });

  it('retries once when the first request does not reach iTrack', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => page(fixture(BILL)));
    fetcher.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(carrier(fetcher).track({ number: BILL }, { budgetMs: 4000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends a container with its check digit, a bill, or a booking with its ports apart', () => {
    expect(sarjakQuery(' sjku 452062-0 ')).toEqual({ kind: 'container', number: SAILING });
    expect(sarjakQuery(BILL)).toEqual({ kind: 'bill', number: BILL });
    for (const booking of ['NSA/SOH/158685', 'nsa-soh-158685', 'NSASOH158685']) {
      expect(sarjakQuery(booking), booking).toEqual({ kind: 'booking', number: 'NSA-SOH-158685' });
    }
    expect(sarjakTrackingUrl('NSA-SOH-158685')).toBe(`${SARJAK_TRACKING}TlNBLVNPSC0xNTg2ODU=`);
    for (const bad of ['SJKU4520621', 'ABC123', 'NSASOH7335', '1'.repeat(70), '']) {
      expect(() => sarjakQuery(bad), bad).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('answers the wordings statuses.json records', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'sarjak-container-lines', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
      expect(sarjakStage(wording)).toBe(stage);
    }
    expect(statusMapAnswer({ carrier: 'sarjak-container-lines', providerCode: null, description: 'Delivered' })).toEqual({ kind: 'unknown' });
  });
});

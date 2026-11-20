import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { IndeterminateError, NoHistoryError, NotFoundError, SchemaError } from '../../core/errors/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { ACPL_CARGO_SESSION, AcplCargoTracker, acplCargoLookupUrl, adapter, normalizeAcplCargoNumber, parseAcplCargo } from './adapter.js';
import { acplCargoStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };
import sample from './fixtures/gc-2531501043.json' with { type: 'json' };
import unknown from './fixtures/not-found.json' with { type: 'json' };

type Reply = typeof sample;
const NUMBER = sample.etransBookingMaster[0]!.docketNo;
const copy = (): Reply => structuredClone(sample);
const SESSION = 'bff.session=0123456789abcdef0123456789abcdef';

type Answer = { status?: number; body?: string; headers?: Record<string, string> };
function harness(lookup: Answer | Answer[] = { body: JSON.stringify(sample) }, session: Answer = {}) {
  const lookups = Array.isArray(lookup) ? [...lookup] : [lookup];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    const answer = url === ACPL_CARGO_SESSION
      ? { status: 200, body: JSON.stringify({ csrfToken: 'PRIVATE', expiresAt: '2026-11-20T18:00:00Z' }),
        headers: { 'set-cookie': `${SESSION}; path=/bff; secure; httponly` }, ...session }
      : { status: 200, ...(lookups.length > 1 ? lookups.shift()! : lookups[0]!) };
    return new Response(answer.body ?? '', { status: answer.status, headers: { 'content-type': 'application/json', ...answer.headers } });
  });
  return { fetcher, tracker: new AcplCargoTracker({ fetcher, recorder: NOOP_RECORDER }) };
}

describe('ACPL Cargo tracker', () => {
  it('reads the example GC: booked at Jaipur, through three hubs, delivered at Lonavala', () => {
    const result = parseAcplCargo(sample, NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2025-06-30T15:51:38+05:30', expected_delivery: null,
      delivered_at: '2025-06-30T15:51:38+05:30', timezone: 'Asia/Kolkata' });
    expect(result.events).toHaveLength(10);
    expect(result.events![0]).toEqual({ time: '2025-06-30T15:51:38+05:30', time_zone: 'Asia/Kolkata',
      time_zone_basis: 'carrier', description: 'Delivered', location: 'PUN-LONAVALA', provider_code: 'Delivered', stage: 'delivered',
      stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toMatchObject({ time: '2025-06-18T18:47:03+05:30', description: 'Booking GC', location: 'JPR-JAIPUR',
      stage: 'accepted' });
    expect(result.events!.map((event) => event.location)).toEqual(['PUN-LONAVALA', 'PUN-LONAVALA', 'PUNE HUB', 'PUNE HUB', 'ASLALI HUB',
      'ASLALI HUB', 'JAIPUR HUB', 'JAIPUR HUB', 'JPR-JAIPUR', 'JPR-JAIPUR']);
  });

  it('gives the expected arrival while the consignment is on its way', () => {
    // Invented: the example before it reached its destination.
    const moving = copy();
    moving.etransBookingMaster[0]!.status = 'In Transit';
    moving.etransDispatchDetails = moving.etransDispatchDetails.slice(0, 5);
    expect(parseAcplCargo(moving, NUMBER)).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Arrived',
      last_update: '2025-06-20T10:39:17+05:30', expected_delivery: '2025-06-21' });
    expect(parseAcplCargo(moving, NUMBER)).not.toHaveProperty('delivered_at');
  });

  it('takes a delivery from the booking’s status when the movements stop short of it', () => {
    // Invented: the proof of delivery filed before the delivery movement was written.
    const filed = copy();
    filed.etransBookingMaster[0]!.status = 'POD SUBMISSION DONE';
    filed.etransDispatchDetails = filed.etransDispatchDetails.slice(0, 9);
    expect(parseAcplCargo(filed, NUMBER)).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Arrived',
      expected_delivery: null });
    expect(parseAcplCargo(filed, NUMBER)).not.toHaveProperty('delivered_at');
  });

  it('keeps a movement it cannot stage, and each movement once', () => {
    // Invented: a movement in words the map does not know, and the delivery repeated.
    const reply = copy();
    const delivered = reply.etransDispatchDetails.at(-1)!;
    reply.etransDispatchDetails.push({ ...delivered }, { ...delivered, sortOrder: 4, date: '2025-06-30 16:00:00', status: 'Bill submitted' });
    const result = parseAcplCargo(reply, NUMBER);
    expect(result.events).toHaveLength(11);
    expect(result.events![0]).toMatchObject({ description: 'Bill submitted' });
    expect(result.events![0]).not.toHaveProperty('stage');
    expect(result).toMatchObject({ current_stage: 'delivered', last_status_text: 'Bill submitted' });
  });

  it('answers only for the GC number asked', () => {
    expect(() => parseAcplCargo(unknown, NUMBER)).toThrow(NotFoundError);
    expect(() => parseAcplCargo({ ...unknown, etransBookingMaster: [], documentNoNotValid: 'FAIL' }, NUMBER)).toThrow(NotFoundError);
    expect(() => parseAcplCargo({ ...unknown, etransBookingMaster: [{ documentNoNotValid: 'PASS' }] }, NUMBER)).toThrow(IndeterminateError);
    expect(() => parseAcplCargo({ ...unknown, etransBookingMaster: [] }, NUMBER)).toThrow(IndeterminateError);
    expect(() => parseAcplCargo(sample, '0000000001')).toThrow(IndeterminateError);
    const other = copy(); other.etransBookingDetails[0]!.gcno = '0000000001';
    expect(() => parseAcplCargo(other, NUMBER)).toThrow(IndeterminateError);
  });

  it('refuses a reply it cannot read', () => {
    const broken = (edit: (reply: Record<string, unknown>) => void) => { const reply = copy() as unknown as Record<string, unknown>; edit(reply); return reply; };
    expect(() => parseAcplCargo(null, NUMBER)).toThrow(SchemaError);
    expect(() => parseAcplCargo(broken((reply) => { delete reply.etransDispatchDetails; }), NUMBER)).toThrow(SchemaError);
    expect(() => parseAcplCargo(broken((reply) => { reply.etransBookingMaster = {}; }), NUMBER)).toThrow(SchemaError);
    expect(() => parseAcplCargo(broken((reply) => { reply.etransDispatchDetails = ['Delivered']; }), NUMBER)).toThrow(SchemaError);
    for (const edit of [{ date: '30/06/2025 15:51' }, { date: '2025-02-30 15:51:38' }, { date: '1999-06-30 15:51:38' }, { status: ' ' }]) {
      const reply = copy(); reply.etransDispatchDetails = [{ ...reply.etransDispatchDetails[0]!, ...edit }];
      expect(() => parseAcplCargo(reply, NUMBER), JSON.stringify(edit)).toThrow(SchemaError);
    }
    const moving = copy(); moving.etransBookingMaster[0]!.status = 'In Transit'; moving.etransBookingMaster[0]!.expectedDate = '2025-06-21';
    moving.etransDispatchDetails = moving.etransDispatchDetails.slice(0, 5);
    expect(() => parseAcplCargo(moving, NUMBER)).toThrow(SchemaError);
    expect(() => parseAcplCargo({ ...copy(), etransDispatchDetails: [] }, NUMBER)).toThrow(NoHistoryError);
  });

  it('takes a ten-digit GC number and refuses anything else before asking', async () => {
    expect(normalizeAcplCargoNumber(' 25315 01043 ')).toBe(NUMBER);
    const h = harness();
    for (const number of ['253150104', '25315010431', '2531-501043', 'L2531501043', '']) {
      await expect(h.tracker.fetch(number), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    for (const { number } of numbers.records) expect(detectCarrierMatch(number).carrier, number).not.toBe('acpl-cargo');
  });

  it('opens a guest session and looks the number up in it', async () => {
    const h = harness();
    await expect(h.tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([ACPL_CARGO_SESSION, acplCargoLookupUrl(NUMBER)]);
    expect(acplCargoLookupUrl(NUMBER)).toBe('https://acplcargo.com/bff/api/etrans?gcNumber=2531501043');
    expect(new Headers(h.fetcher.mock.calls[1]![1]!.headers).get('cookie')).toBe(SESSION);
    expect(adapter({ env: {}, browserExecutablePath: null, recorder: NOOP_RECORDER, trawl: null, fetcher: h.fetcher }))
      .toMatchObject({ id: 'acpl-cargo', steps: ['direct', 'retry'] });
  });

  it('reads each answer as what it is', async () => {
    await expect(harness({ body: JSON.stringify(unknown) }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(harness({ status: 401, body: '{"error":"unauthorized"}' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate' });
    await expect(harness({ status: 403, body: '' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness({ status: 429, body: '', headers: { 'retry-after': '60' } }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(harness({ status: 404, body: '' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'transport' });
    await expect(harness({ body: '<html><title>Just a moment...</title></html>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness({ body: '<html>maintenance</html>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness(undefined, { headers: {} }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    await expect(harness(undefined, { status: 403, body: '' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await expect(harness(undefined, { body: '<html><div class="cf-turnstile"></div></html>' }).tracker.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
  });

  it('maps every movement it has seen or the tracker names', () => {
    for (const entry of statuses.entries) {
      expect(acplCargoStage(entry.code), entry.code).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'acpl-cargo', providerCode: entry.code, description: entry.wording }), entry.code)
        .toMatchObject({ kind: 'mapped', stage: entry.stage });
    }
  });
});

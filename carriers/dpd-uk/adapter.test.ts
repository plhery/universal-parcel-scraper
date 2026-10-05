import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, DpdUkTracker } from './adapter.js';
import { normalizeDpdUkNumber, parseDpdUkHistory, parseDpdUkReference } from './parser.js';

const NUMBER = '15500000000001';
const CODE = `${NUMBER}*10000`;
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/delivered.json', import.meta.url), 'utf8'));
const project = (payload = fixture()) => parseDpdUkHistory(payload.detail, payload.history, NUMBER, CODE);
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

describe('DPD UK public history projection', () => {
  it('binds the exact formatted number and handle, preserving local clocks and source order', () => {
    const payload = fixture();
    expect(parseDpdUkReference(payload.reference, NUMBER)).toBe(CODE);
    const result = project(payload);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-01-06T08:15:00' });
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'in_transit', 'in_transit', 'registered']);
    expect(result.events?.every(event => event.time === undefined)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-SYNTHETIC|10000|15500000000001/);
  });

  it.each(['different', 'missing', 'malformed', 'ambiguous', 'unsafe-handle'])('rejects a %s reference lookup', mode => {
    const payload = fixture().reference;
    if (mode === 'different') payload.data[0].parcelNumber = '1550 0000 000 002 A';
    if (mode === 'missing') delete payload.data[0].parcelNumber;
    if (mode === 'malformed') payload.data[0].parcelNumber += 'OTHER';
    if (mode === 'ambiguous') payload.data.push(payload.data[0]);
    if (mode === 'unsafe-handle') payload.data[0].parcelCode = '../private?token=PRIVATE-SYNTHETIC';
    expect(() => parseDpdUkReference(payload, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['number', 'handle', 'missing-handle', 'scan-number', 'scan-handle'])('rejects contradictory %s identity', mode => {
    const payload = fixture();
    if (mode === 'number') payload.detail.data.parcelNumber = '1550 0000 000 002 A';
    if (mode === 'handle') payload.detail.data.parcelCode = `${NUMBER}*20000`;
    if (mode === 'missing-handle') delete payload.detail.data.parcelCode;
    if (mode === 'scan-number') payload.history.data[0].parcelNumber = '1550 0000 000 002 A';
    if (mode === 'scan-handle') payload.history.data[0].parcelCode = `${NUMBER}*20000`;
    expect(() => project(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('requires nonempty history and validates all rows before truncation', () => {
    const payload = fixture(); payload.history.data = [];
    expect(() => project(payload)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const row of [null, {}, { eventText: [], eventDate: '2026-01-01 01:00:00' }]) {
      const malformed = fixture(); malformed.history.data.unshift(row);
      expect(() => project(malformed)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
    payload.history.data = Array.from({ length: 1001 }, () => fixture().history.data[0]);
    expect(() => project(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
    payload.history.data = Array.from({ length: 101 }, (_, index) => ({ eventText: `Scan ${index}`, eventDate: '2026-01-01 01:00:00' }));
    expect(project(payload).events).toHaveLength(100);
    payload.history.data[100] = {};
    expect(() => project(payload)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it.each(['invalid', '2026-02-30 12:00:00', '2026-01-06T08:15:00+99:00', '2026-01-06T08:15:00+02:99',
    '2026-01-06T08:15:00+14:01', '2026-01-06 24:00:00'])('keeps invalid newest clock unresolved: %s', clock => {
    const payload = fixture(); payload.history.data[0].eventDate = clock;
    payload.history.data[1].eventDate = '2026-01-06T07:00:00Z';
    const result = project(payload);
    expect(result.last_update).toBeNull(); expect(result.last_update_local).toBeUndefined(); expect(result.delivered_at).toBeUndefined();
    expect(result.events?.[0]).toMatchObject({ provider_time_text: clock, stage: 'delivered' });
    expect(result.events?.[0]?.time).toBeUndefined(); expect(result.events?.[1]?.time).toBe('2026-01-06T07:00:00Z');
  });

  it('accepts a stated instant and never borrows a movement time for a terminal summary', () => {
    const payload = fixture(); payload.history.data[0].eventDate = '2026-01-06T08:15:00+01:00';
    expect(project(payload)).toMatchObject({ last_update: '2026-01-06T08:15:00+01:00', delivered_at: '2026-01-06T08:15:00+01:00' });
    payload.history.data[0].eventText = 'Your parcel is at our depot';
    expect(project(payload)).toMatchObject({ status: 'delivered', last_update: '2026-01-06T08:15:00+01:00' });
    expect(project(payload).delivered_at).toBeUndefined();
  });

  it('uses the authoritative current summary and preserves unknown wording as unknown', () => {
    const payload = fixture(); payload.detail.data.trackingStatusCurrent = 'Your parcel will be with you today';
    expect(project(payload)).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
    payload.detail.data.trackingStatusCurrent = 'Unrecognized checkpoint';
    payload.history.data = [{ eventText: 'Unrecognized checkpoint', eventDate: '2026-01-06 08:15:00' }];
    const result = project(payload);
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined();
  });

  it('does not borrow a delivered stage from history when the current summary is unrecognized', () => {
    const payload = fixture(); payload.detail.data.trackingStatusCurrent = 'Unrecognized current checkpoint';
    payload.history.data[0].eventDate = '2026-01-06T08:15:00Z';
    const result = project(payload);
    expect(result.events?.[0]).toMatchObject({ stage: 'delivered', time: '2026-01-06T08:15:00Z' });
    expect(result.status).toBe('unknown'); expect(result.current_stage).toBeUndefined(); expect(result.delivered_at).toBeUndefined();
    expect(result.last_status_text).toBe('Unrecognized current checkpoint');
  });

  it('sanitizes recipient wording while retaining sender-return semantics', () => {
    const payload = fixture(); payload.detail.data.trackingStatusCurrent = 'Your parcel has been delivered to PRIVATE-SYNTHETIC';
    payload.history.data[0].eventText = 'Your parcel has been delivered and signed for by PRIVATE-SYNTHETIC';
    expect(project(payload).status).toBe('delivered'); expect(JSON.stringify(project(payload))).not.toContain('PRIVATE-SYNTHETIC');
    payload.detail.data.trackingStatusCurrent = 'The parcel has been delivered back to the sender';
    payload.history.data[0].eventText = 'The parcel has been delivered back to the sender';
    expect(project(payload).current_stage).toBe('returned');
  });

  it('maps the observed partner wording without assigning numeric codes', () => {
    const payload = fixture(); delete payload.detail.data.trackingStatusCurrent;
    payload.history.data[0].eventText = 'The parcel is on the vehicle for delivery';
    expect(project(payload)).toMatchObject({ current_stage: 'out_for_delivery', current_stage_source: 'carrier_map' });
  });
});

describe('DPD UK anonymous retrieval', () => {
  it('performs three bounded reads with an empty postcode and server-returned handle', async () => {
    const payload = fixture();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(payload.reference)).mockResolvedValueOnce(json(payload.detail)).mockResolvedValueOnce(json(payload.history));
    const instance = adapter({ fetcher, env: {}, trawl: null, browserExecutablePath: null, recorder: NOOP_RECORDER });
    await instance.track({ number: NUMBER, postcode: 'PRIVATE-SYNTHETIC' });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `https://apis.track.dpd.co.uk/v1/reference?origin=PRTK&postcode=&referenceNumber=${NUMBER}`,
      `https://apis.track.dpd.co.uk/v1/parcels/${CODE}`,
      `https://apis.track.dpd.co.uk/v1/parcels/${CODE}/parcelevents`,
    ]);
    expect(fetcher.mock.calls.every(call => call[1]?.signal instanceof AbortSignal && call[1]?.redirect === 'error')).toBe(true);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('PRIVATE-SYNTHETIC');
  });

  it('stops before history when the detail identity contradicts the lookup', async () => {
    const payload = fixture(); payload.detail.data.parcelCode = 'PRIVATE-SYNTHETIC';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(payload.reference)).mockResolvedValueOnce(json(payload.detail));
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['exact', 'generic', 'contradictory'])('distinguishes %s reference 404', async mode => {
    const payload: Record<string, unknown> = { error: { statusCode: 404, error: 'Not Found', message: mode === 'generic' ? 'Not Found' : 'Your reference number could not be found' } };
    if (mode === 'contradictory') payload.data = fixture().reference.data;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(payload, 404));
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: mode === 'exact' ? 'not_found' : 'transport' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [503, 'maintenance']])('keeps detail HTTP %s separate from parcel absence and removes handle diagnostics', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture().reference))
      .mockResolvedValueOnce(new Response(`PRIVATE-SYNTHETIC ${CODE}`, { status: Number(status), headers: { 'Content-Type': 'text/plain' } }));
    const error = await new DpdUkTracker({ fetcher }).fetch(NUMBER).catch(error => error);
    expect(error).toMatchObject({ kind });
    expect(error.cause).toBeUndefined(); expect(error.request).toBeUndefined(); expect(error.diagnostics).toBeUndefined();
    expect(String(error)).not.toMatch(/PRIVATE-SYNTHETIC|10000/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('discards malformed payload bodies and opaque handles from parser error causes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(fixture().reference))
      .mockResolvedValueOnce(new Response(`PRIVATE-SYNTHETIC ${CODE}`));
    const error = await new DpdUkTracker({ fetcher }).fetch(NUMBER).catch(error => error);
    expect(error.kind).toBe('schema'); expect(error.cause).toBeUndefined(); expect(error.response_body).toBeUndefined();
  });

  it('preserves cancellation before and between requests', async () => {
    const reason = new Error('Caller canceled'); const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      controller.abort(reason); return json(fixture().reference);
    });
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledOnce();
    fetcher.mockClear();
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds response allocation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1_000_001)));
    await expect(new DpdUkTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'indeterminate', reason: 'response_too_large' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['123', `${NUMBER}&other=1`, 'ORDER-REFERENCE'])('rejects unsupported input %s before I/O', async number => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new DpdUkTracker({ fetcher }).fetch(number)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeDpdUkNumber('1550 0000 000 001')).toBe(NUMBER);
  });
});

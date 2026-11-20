import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { OverseasTracker } from './adapter.js';
import { normalizeOverseasNumber, overseasFields, overseasPayload, overseasRequest, parseOverseas } from './parser.js';
import { overseasStage, statusMap } from './status.js';

const NUMBER = '18497957';
const text = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as { payload: Record<string, unknown> & { eventDetailList: Record<string, unknown>[] } };
const payload = (name = 'delivered.json') => fixture(name).payload;
const response = (body: string, status = 200) => new Response(body, { status });
const statuses = JSON.parse(text('../statuses.json')) as { entries: { code?: string; wording: string; stage?: string; note?: string }[] };
const replying = (...bodies: string[]) => {
  const fetcher = vi.fn<typeof fetch>();
  for (const body of bodies) fetcher.mockResolvedValueOnce(response(body));
  return fetcher;
};
const requests = (fetcher: ReturnType<typeof replying>) => (fetcher.mock.calls as [string, RequestInit][])
  .map(([url, init]) => ({ url, body: JSON.parse(init.body as string) as unknown }));

describe('Overseas Express tracker', () => {
  it('asks the guest lookup for the parcel number in English, with the supplied transport and budget', async () => {
    const fetcher = replying(text('delivered.json'));
    const recorder = { ...NOOP_RECORDER, step: vi.fn() };
    const result = await new OverseasTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1' }).fetch(' 1849-7957 ', { budgetMs: 4000 });
    expect(result.events).toHaveLength(6);
    expect(requests(fetcher)).toEqual([{ url: 'https://inetapi.overseas.hr/NesyIntegration/GetGuestShipmentDetails',
      body: { Platform: 201, Reference: NUMBER } }]);
    const [[, init]] = fetcher.mock.calls as [[string, RequestInit]];
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), headers: {
      'Accept-Language': 'en-US', 'Content-Type': 'application/json', Origin: 'https://inet.overseas.hr', 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'overseas-express', step: 'direct', outcome: 'ok' }));
  });

  it('reads the scans newest first as the instants the service states, at their hubs', () => {
    const result = parseOverseas(payload(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'The shipment has been delivered.', last_update: '2026-07-28T09:09:04Z', delivered_at: '2026-07-28T09:09:04Z',
      expected_delivery: null });
    expect(result.events!.map(event => [event.time, event.provider_code, event.stage, event.location])).toEqual([
      ['2026-07-28T09:09:04Z', 'DELY', 'delivered', 'OSE Sesvete (Central)'],
      ['2026-07-28T06:03:28Z', 'TOUR', 'out_for_delivery', 'OSE Sesvete (Central)'],
      ['2026-07-28T05:20:10Z', 'IMPA', 'exception', 'OSE Sesvete (Central)'],
      ['2026-07-28T04:54:30Z', 'ENTY', 'in_transit', 'OSE Sesvete (Central)'],
      ['2026-07-27T15:31:32Z', 'INIT', 'in_transit', 'OSE Zagreb (Central)'],
      ['2026-07-22T05:38:45Z', 'DDEF', 'registered', 'OSE Zagreb (Central)'],
    ]);
    expect(result.events!.every(event => event.local_time === undefined)).toBe(true);
    expect(parseOverseas(payload('delivered-2.json'), '14294365').events!.map(event => event.provider_code)).toEqual(['DELY', 'TOUR', 'INIT', 'DDEF']);
  });

  it('binds the reply to the parcel number, its eight inner digits or the shipment number', () => {
    for (const number of ['18497957', '1910051849795713', '26315638889445']) expect(parseOverseas(payload(), number).status).toBe('delivered');
    for (const number of ['18497958', '1910051849795714', '26315638889446', '91005184']) {
      expect(() => parseOverseas(payload(), number), number).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('asks a fourteen-digit code as a shipment number, then as a parcel number', async () => {
    expect(overseasFields('26315638889445')).toEqual(['ExternalId', 'Reference']);
    expect(overseasFields('1910051849795713')).toEqual(['Reference']);
    expect(overseasRequest('26315638889445', 'ExternalId')).toEqual({ Platform: 201, ExternalId: '26315638889445' });
    const found = replying(text('delivered.json'));
    await new OverseasTracker({ fetcher: found }).fetch('26315638889445');
    expect(requests(found).map(request => request.body)).toEqual([{ Platform: 201, ExternalId: '26315638889445' }]);
    const missing = replying(text('not-found.json'), text('not-found.json'));
    await expect(new OverseasTracker({ fetcher: missing }).fetch('00000000000000')).rejects.toMatchObject({ kind: 'not_found' });
    expect(requests(missing).map(request => request.body)).toEqual([
      { Platform: 201, ExternalId: '00000000000000' }, { Platform: 201, Reference: '00000000000000' }]);
  });

  it('reports an unknown code as not found, and never a refusal', async () => {
    expect(() => overseasPayload(text('not-found.json'))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => overseasPayload('{"resultCode":400,"resultMessage":"barcodesNotFound","payload":null}'))
      .toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => overseasPayload('{"resultCode":400,"resultMessage":"configurationNotFound","payload":null}'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => overseasPayload('{"resultCode":200,"payload":null}')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => overseasPayload('<html><head><title>403 Forbidden</title></head></html>')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => overseasPayload('<html>Error</html>')).toThrow(expect.objectContaining({ kind: 'schema' }));
    for (const status of [403, 429, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response('<html>Forbidden</html>', status));
      await expect(new OverseasTracker({ fetcher }).fetch(NUMBER, { budgetMs: 2000 })).rejects.not.toMatchObject({ kind: 'not_found' });
    }
  });

  it('keeps a listed shipment without scans apart from an unknown one, and rejects unreadable scans', () => {
    const edited = (change: (rows: Record<string, unknown>[]) => void) => {
      const copy = payload();
      change(copy.eventDetailList);
      return copy;
    };
    expect(() => parseOverseas(edited(rows => rows.splice(0)), NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
    expect(() => parseOverseas(edited(rows => { rows[0]!.timeStamp = '2026-02-30T10:00:00Z'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOverseas(edited(rows => { rows[0]!.timeStamp = '2026-07-28T09:09:04'; }), NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOverseas(edited(rows => { rows[0]!.legacySystemShortEventCode = ''; rows[0]!.eventType = ''; }), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOverseas({ ...payload(), shipmentDetails: null }, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    // Without a former code, the scan type names the scan.
    const typed = parseOverseas(edited(rows => { rows[0]!.legacySystemShortEventCode = null; }), NUMBER).events![0]!;
    expect(typed).toMatchObject({ provider_code: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
  });

  it('rejects malformed input before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new OverseasTracker({ fetcher }).fetch('1849,7957')).rejects.toMatchObject({ kind: 'invalid_input' });
    for (const raw of ['1234567', '12345678901234567', '../x']) expect(() => normalizeOverseasNumber(raw)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Overseas Express status map', () => {
  it('stages each code it lists and leaves failed collections without a stage', () => {
    for (const entry of statuses.entries.filter(each => each.code)) {
      expect(statusMap.stage(entry.code!, normalizeStatusWording(entry.wording)), entry.code).toBe(entry.stage);
      expect(overseasStage(entry.code!, '', entry.wording)?.stage ?? null, entry.code).toBe(entry.stage ?? null);
    }
    expect(statusMap.gaps.map(gap => gap.code ?? gap.wording)).toEqual(['prikupljena gotovina (prijevoz, pouzeće).', 'NPNP', 'NRDY', 'PABS', 'PADU']);
    // The former code wins over the scan type, which gives no stage of its own here.
    expect(overseasStage('ENTY', 'LegacySystemInfo', 'The shipment has arrived at the delivery center.')).toEqual({ stage: 'in_transit', source: 'carrier_map' });
    expect(overseasStage('NRDY', 'PickupFailed', 'Shipment not ready for pickup')).toBeNull();
    expect(overseasStage('ZZZZ', 'LegacySystemInfo', 'Synthetic scan')).toBeNull();
  });

  it("reads the former tracker's Croatian wording whole when it comes without a code", () => {
    expect(statusMap.stage(null, normalizeStatusWording('Pošiljka isporučena, dostava potvrđena'))).toBe('delivered');
    expect(statusMap.stage(null, normalizeStatusWording('Pošiljka utovarena za dostavu. Očekuje se dostava tijekom dana.'))).toBe('out_for_delivery');
    expect(statusMap.stage(null, 'the shipment has been delivered.')).toBeUndefined();
  });
});

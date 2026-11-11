import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../app.js';
import { deliveryHandoff } from '../../core/catalog/handoff.js';
import { recognitionAskedCarriers } from '../../core/catalog/recognition.js';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, SENGI_API, SengiExpressTracker } from './adapter.js';
import { normalizeSengiExpressNumber, parseSengiExpress } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// Synthetic: an SDA waybill's shape, never issued.
const NUMBER = '100C00000001F';
type Row = Record<string, unknown>;
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/sda-waybill.json', import.meta.url), 'utf8')) as Record<string, Row[]>;
const rows = () => fixture()[NUMBER]!;
const reply = (body: unknown, status = 200, headers: HeadersInit = { 'content-type': 'application/json;charset=UTF-8' }) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const CAPABILITIES = (JSON.parse(readFileSync(new URL('./carrier.json', import.meta.url), 'utf8')) as { capabilities: string[] }).capabilities;
const environment = (fetcher: typeof fetch) => ({ fetcher, trawl: null, browserExecutablePath: null, env: {}, recorder: NOOP_RECORDER });

describe('Sengi Express tracking', () => {
  it('posts the number as the tracker does and reads its rows newest first on the offsets they state', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture()));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    const result = await new SengiExpressTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 100c 0000 0001f ', { budgetMs: 5000 });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(SENGI_API);
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(JSON.parse(String(init!.body))).toEqual({ trackingNumberList: [NUMBER], type: 1 });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'sengi-express', step: 'direct', outcome: 'ok' }));

    expect(result).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', current_stage_source: 'carrier_map',
      last_status_text: 'Ready for transit to last mile operator', last_update: '2026-04-02T16:45:00+02:00',
      expected_delivery: null, delivery_carrier: 'poste-italiane',
    });
    expect(result.delivery_tracking_number).toBeUndefined();
    expect(result.events?.map((event) => [event.time, event.stage, event.location, event.provider_code])).toEqual([
      ['2026-04-02T16:45:00+02:00', 'in_transit', 'FCO', '50'],
      ['2026-03-30T11:15:00+02:00', 'customs', 'FCO', '41'],
      ['2026-03-29T08:30:00+02:00', 'customs', 'FCO', '40'],
      ['2026-03-26T10:05:00+01:00', 'in_transit', 'FCO', '31'],
      ['2026-03-26T06:40:00+01:00', 'in_transit', 'FCO', '30'],
      // "-" names no place.
      ['2026-03-20T09:12:40+01:00', 'registered', undefined, '10'],
    ]);
    // The order number Sengi keeps beside each row is the shop's, not the parcel's.
    expect(JSON.stringify(result)).not.toContain('AP0000000000000000');
  });

  it('returns every declared capability from the fixture', async () => {
    const result = parseSengiExpress(fixture(), NUMBER);
    const produced = new Set<string>();
    if (result.events?.length) produced.add('history');
    if (result.events?.some((event) => event.location)) produced.add('location');
    if (result.events?.some((event) => event.provider_code)) produced.add('provider_code');
    if (result.delivery_carrier) produced.add('delivery_partner');
    expect([...produced].sort()).toEqual([...CAPABILITIES].sort());
  });

  it('hands the parcel to Poste Italiane under the same waybill once Sengi readies it for the last mile', () => {
    expect(deliveryHandoff('sengi-express', NUMBER, parseSengiExpress(fixture(), NUMBER))).toEqual({ carrier: 'poste-italiane', number: NUMBER, basis: 'partner' });
  });

  it('names the code Sengi relabels the parcel with, and no partner off its line to Poste Italiane', () => {
    const relabelled = rows().map((row) => ({ ...row, relabelTrackingNumber: 'RR000000000IT' }));
    expect(parseSengiExpress({ [NUMBER]: relabelled }, NUMBER)).toMatchObject({ delivery_carrier: 'poste-italiane', delivery_tracking_number: 'RR000000000IT' });
    const elsewhere = rows().map((row) => ({ ...row, channelCode: 'XX' }));
    expect(parseSengiExpress({ [NUMBER]: elsewhere }, NUMBER).delivery_carrier).toBeUndefined();
  });

  it('keeps the wall clock of a row without an offset', () => {
    const result = parseSengiExpress({ [NUMBER]: rows().map((row) => ({ ...row, timeZone: null })) }, NUMBER);
    expect(result).toMatchObject({ last_update: null, last_update_local: '2026-04-02T16:45:00' });
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-04-02T16:45:00' });
    expect(result.events?.[0]?.time).toBeUndefined();
  });

  it.each([
    { name: 'an empty object', body: {} },
    { name: 'an empty list of rows', body: { [NUMBER]: [] } },
  ])('reads $name as not found', ({ body }) => {
    expect(() => parseSengiExpress(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'not_found' }));
  });

  it.each([
    { name: 'another parcel', body: { '100C00000002F': rows() } },
    { name: 'a second parcel beside it', body: { ...fixture(), '100C00000002F': rows() } },
    { name: 'a row naming another parcel', body: { [NUMBER]: rows().map((row) => ({ ...row, trackingNumber: '100C00000002F' })) } },
    { name: 'a row without a time', body: { [NUMBER]: rows().map((row) => ({ ...row, eventTime: null })) } },
    { name: 'rows that are not a list', body: { [NUMBER]: {} } },
  ])('rejects $name rather than manufacturing tracking success', ({ body }) => {
    expect(() => parseSengiExpress(body, NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('reports a bot check, whatever its status, as a challenge and a rate limit as such', async () => {
    const page = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>';
    const track = (response: Response) => new SengiExpressTracker({ fetcher: vi.fn<typeof fetch>().mockResolvedValue(response) }).fetch(NUMBER);
    await expect(track(reply(page, 200, { 'content-type': 'text/html' }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(reply(page, 403, { 'content-type': 'text/html' }))).rejects.toMatchObject({ kind: 'challenge' });
    await expect(track(reply('', 429, { 'retry-after': '20' }))).rejects.toMatchObject({ kind: 'rate_limited' });
    await expect(track(reply('<html><body>Bad gateway</body></html>', 200, { 'content-type': 'text/html' }))).rejects.toMatchObject({ kind: 'schema' });
  });

  it('refuses a number its tracker cannot hold before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new SengiExpressTracker({ fetcher }).fetch('100C')).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(() => normalizeSengiExpressNumber('x'.repeat(65))).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Sengi Express recognition', () => {
  const recognize = (fetcher: typeof fetch, number = NUMBER) => adapter(environment(fetcher)).recognize!(number);

  it('knows an SDA waybill its tracker holds and not one it does not', async () => {
    await expect(recognize(vi.fn<typeof fetch>().mockResolvedValue(reply(fixture())))).resolves.toMatchObject({ known: true });
    await expect(recognize(vi.fn<typeof fetch>().mockResolvedValue(reply({})))).resolves.toEqual({ known: false });
  });

  it("is not asked about Poste Italiane's codes, which its tracker also finds", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(recognize(fetcher, 'RR000000000IT')).resolves.toEqual({ known: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('is offered for an SDA waybill beside Poste Italiane and AliExpress, and asked about it', () => {
    expect(detectCarrierMatch(NUMBER)).toMatchObject({ confidence: 'low' });
    expect(detectCarrierMatch(NUMBER).candidates).toEqual(expect.arrayContaining(['poste-italiane', 'aliexpress', 'sengi-express']));
    expect(recognitionAskedCarriers(NUMBER, {})).toContain('sengi-express');
    expect(recognitionAskedCarriers('SNGXP000000000MT', {})).not.toContain('sengi-express');
  });
});

describe('Sengi Express status map', () => {
  it("answers Sengi's code and wordings", () => {
    const answer = (providerCode: string | null, description: string) => statusMapAnswer({ carrier: 'sengi-express', providerCode, description });
    expect(answer('10', 'Order information received.')).toEqual({ kind: 'mapped', stage: 'registered' });
    expect(answer(null, 'Ready for transit to last mile operator')).toEqual({ kind: 'mapped', stage: 'in_transit' });
  });

  it('stages every recorded status as statuses.json says', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage?: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording), entry.wording).toBe(entry.stage);
    }
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { createTracker } from '../../facade/index.js';
import { adapter, GOLILLA_API, GolillaTracker } from './adapter.js';
import { normalizeGolillaNumber, parseGolilla } from './parser.js';
import { golillaStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public samples' shipments: one parcel, and three parcels delivered together.
const DELIVERED = '4550534';
const PARCELS = '4391636';
const UNKNOWN = '9999999';

type Row = Record<string, unknown>;
type Parcel = Row & { esiti: Row[] };
type Tracking = Row & { colli: Parcel[] };
type Reply = Row & { tracking: Tracking };

const text = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8');
const fixture = (name: string) => JSON.parse(text(name)) as Reply;
const changed = (name: string, change: (tracking: Tracking, reply: Reply) => void) => {
  const body = fixture(name);
  change(body.tracking, body);
  return body;
};
const reply = (body: unknown, status = 200, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// The page the SafeLine firewall serves while it checks a browser, and DataDome's, trimmed.
const SAFELINE = '<!DOCTYPE html><html lang="it"><head><title>Controllo di Sicurezza</title></head><body><p>Attendere prego, controlli di sicurezza in corso...</p></body></html>'
  + '<script>install("/.safeline/challenge/v2/challenge.js");</script>';
const DATADOME = '<html lang="en"><head><title>golilla.it</title></head><body><script>var dd={\'host\':\'geo.captcha-delivery.com\'}</script>'
  + '<script src="https://ct.captcha-delivery.com/c.js"></script></body></html>';

describe('Golilla HTTP adapter', () => {
  it('asks the tracking page’s lookup for the whole number once, as the page, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new GolillaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' 455 0534 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${GOLILLA_API}${DELIVERED}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', Referer: 'https://my.golilla.it/', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'golilla', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads a delivered shipment newest first at Italy’s offset, with its booked and cancelled appointments', () => {
    const result = parseGolilla(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'SPEDIZIONE CONSEGNATA', last_update: '2026-03-05T17:28:05+01:00', delivered_at: '2026-03-05T17:28:05+01:00',
      expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage ?? null])).toEqual([
      ['2026-03-05T17:28:05+01:00', '1', 'delivered'],
      ['2026-03-05T06:00:14+01:00', '52', 'out_for_delivery'],
      ['2026-03-04T17:45:53+01:00', '51', 'out_for_delivery'],
      ['2026-03-04T13:50:14+01:00', '58', 'in_transit'],
      ['2026-03-02T16:19:32+01:00', '58', 'in_transit'],
      // A cancelled appointment moves nothing.
      ['2026-03-02T16:10:03+01:00', '82', null],
      ['2026-03-02T16:09:29+01:00', '58', 'in_transit'],
      ['2026-03-02T13:11:52+01:00', '48', 'in_transit'],
      ['2026-03-02T10:41:28+01:00', '72', 'in_transit'],
      ['2026-03-02T10:41:27+01:00', '4', 'accepted'],
      ['2026-02-27T15:32:19+01:00', '50', 'registered'],
    ]);
    expect(result.events!.every((event) => event.location === 'Golilla Milano Est' && event.description)).toBe(true);
    // The recipient's place, the sender and its references, the parcels' references and the proof of delivery stay out.
    expect(JSON.stringify(result)).not.toMatch(/Cesano|20090|LEROYMERLIN|005-035|00801796541302615736|11192008|661951|avanzament|CONSEGNA PRENOTATA/);
    expect(result).not.toHaveProperty('local_time');
  });

  it('keeps a booked delivery at the destination branch after a cancelled appointment, with the planned day', () => {
    const booked = parseGolilla(changed('delivered', (tracking) => {
      tracking.colli[0]!.esiti = tracking.colli[0]!.esiti.filter((scan) => String(scan.eventDateTime) <= '2026-03-02T15:10:03Z');
    }), DELIVERED);
    expect(booked).toMatchObject({ status: 'in_transit', current_stage: 'in_transit', last_status_text: 'PRENOTAZIONE ANNULLATA',
      last_update: '2026-03-02T16:10:03+01:00', expected_delivery: '2026-03-03' });
    expect(booked).not.toHaveProperty('delivered_at');
  });

  it('merges the parcels’ scans and keeps each parcel’s own arrival, but a repeat within a minute once', () => {
    const result = parseGolilla(fixture('delivered-parcels'), PARCELS);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2025-06-25T10:33:00+02:00', expected_delivery: null });
    expect(result.events!.map((event) => [event.time, event.provider_code])).toEqual([
      ['2025-06-25T10:33:00+02:00', '1'],
      ['2025-06-25T08:43:01+02:00', '52'],
      ['2025-06-25T08:37:35+02:00', '51'],
      ['2025-06-24T17:09:15+02:00', '58'],
      ['2025-06-24T17:03:58+02:00', '58'],
      ['2025-06-24T15:48:19+02:00', '48'],
      ['2025-06-18T10:56:54+02:00', '48'],
      ['2025-06-18T10:55:39+02:00', '72'],
      ['2025-06-18T10:55:38+02:00', '4'],
      ['2025-06-18T10:18:02+02:00', '72'],
      ['2025-06-18T10:18:01+02:00', '4'],
      ['2025-06-18T10:16:57+02:00', '72'],
      ['2025-06-18T10:16:56+02:00', '4'],
      ['2025-06-17T12:15:28+02:00', '50'],
    ]);
  });

  it('does not deliver a shipment while one of its parcels is still on its way', () => {
    const partial = parseGolilla(changed('delivered-parcels', (tracking) => { tracking.colli[1]!.esiti.pop(); }), PARCELS);
    expect(partial).toMatchObject({ status: 'out_for_delivery', current_stage: 'out_for_delivery', last_status_text: 'SPEDIZIONE CONSEGNATA',
      expected_delivery: '2025-06-26' });
    expect(partial).not.toHaveProperty('delivered_at');
    const returning = parseGolilla(changed('delivered-parcels', (tracking) => {
      Object.assign(tracking.colli[1]!.esiti.at(-1)!, { codEsito: 31, descEsito: 'RIENTRO AL MITTENTE' });
    }), PARCELS);
    expect(returning).toMatchObject({ status: 'exception', current_stage: 'returned', expected_delivery: null });
  });

  it('gives the day the page shows first, then the updated and first planned days, and names an unread slot', () => {
    const open = (change: (tracking: Tracking) => void) => parseGolilla(changed('delivered', (tracking) => {
      tracking.colli[0]!.esiti.splice(-3);
      change(tracking);
    }), DELIVERED);
    expect(open(() => {})).toMatchObject({ current_stage: 'in_transit', expected_delivery: '2026-03-03' });
    expect(open((tracking) => { tracking.estimatedArrivalDate = '2026-03-05'; })).toMatchObject({ expected_delivery: '2026-03-05' });
    expect(open((tracking) => {
      tracking.dataPrevistaConsegnaAggiornata = null;
      tracking.dataPrevistaConsegnaTeorica = '2026-03-04';
    })).toMatchObject({ expected_delivery: '2026-03-04' });
    expect(open((tracking) => {
      tracking.dataPrevistaConsegnaAggiornata = '2026-02-30';
      tracking.dataPrevistaConsegnaTeorica = null;
    })).toMatchObject({ expected_delivery: null });
    expect(open(() => {})).not.toHaveProperty('unread_estimates');
    expect(open((tracking) => Object.assign(tracking, { estimatedArrivalDate: '2026-03-05', estimatedArrivalTimeStart: '08:00:00',
      estimatedArrivalTimeFinish: '10:00:00' }))).toMatchObject({ expected_delivery: '2026-03-05',
      unread_estimates: ['estimatedArrivalTimeStart', 'estimatedArrivalTimeFinish'] });
  });

  it('gives the summary’s event for a shipment whose parcels have no scan yet', () => {
    const registered = parseGolilla(changed('delivered', (tracking) => {
      tracking.colli[0]!.esiti = [];
      Object.assign(tracking, { codEvento: 50, descEvento: 'RICEZIONE FILE', dateTimeEv: '2026-02-27T14:32:19Z' });
    }), DELIVERED);
    expect(registered).toEqual({ status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: 'RICEZIONE FILE', provider_code: '50', last_update: '2026-02-27T15:32:19+01:00',
      expected_delivery: '2026-03-03', summary_only: true, events: [] });
    expect(() => parseGolilla(changed('delivered', (tracking) => {
      tracking.colli = [];
      Object.assign(tracking, { codEvento: null, descEvento: null, dateTimeEv: null });
    }), DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate', name: 'NoHistoryError' }));
  });

  it('counts a shipment only when it gives back the number asked', () => {
    expect(() => parseGolilla(fixture('delivered'), PARCELS))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Golilla answered for another shipment' }));
    expect(() => parseGolilla(fixture('delivered'), '45505340')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseGolilla({ status: { code: 500, message: 'Error' }, tracking: null }, DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('rejects a changed reply', () => {
    for (const change of [
      (_tracking: Tracking, body: Reply) => { delete (body as Row).status; },
      (_tracking: Tracking, body: Reply) => { delete (body as Row).tracking; },
      (tracking: Tracking) => { tracking.ldv = DELIVERED; },
      (tracking: Tracking) => { tracking.ldv = 4550534.5; },
      (tracking: Tracking) => { tracking.colli = 'parcels' as never; },
      (tracking: Tracking) => { tracking.colli = Array.from({ length: 201 }, () => tracking.colli[0]!); },
      (tracking: Tracking) => { tracking.colli[0] = 'parcel' as never; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti = 'scans' as never; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti = Array.from({ length: 1001 }, () => tracking.colli[0]!.esiti[0]!); },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0] = 'scan' as never; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.eventDateTime = '2026-02-27 14:32:19'; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.eventDateTime = '2026-02-30T14:32:19Z'; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.eventDateTime = null; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.codEsito = '50'; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.codEsito = null; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.descEsito = ' '; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.descEsito = ['IN CONSEGNA']; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti[0]!.descFiliale = 7; },
      (tracking: Tracking) => { tracking.colli[0]!.esiti.splice(-3); tracking.dataPrevistaConsegnaAggiornata = 20260303; },
    ]) {
      expect(() => parseGolilla(changed('delivered', change), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('keeps an unknown number, a moved route, a bot check and a broken reply apart', async () => {
    const lookup = (body: unknown, status?: number, type?: string) =>
      carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, status, type))).track({ number: UNKNOWN });
    await expect(lookup(text('not-found'), 404)).rejects.toMatchObject({ kind: 'not_found' });
    // A 404 without the service's own answer, a 410 or a redirect is a moved route.
    await expect(lookup({ error: 'RESTEASY003210: Could not find resource for full path' }, 404)).rejects.toMatchObject({ kind: 'transport', status: 404 });
    await expect(lookup('<html><body>Not Found</body></html>', 404, 'text/html')).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', 410)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', 302)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup(SAFELINE, 468, 'text/html')).rejects.toMatchObject({ kind: 'challenge', status: 468 });
    await expect(lookup(SAFELINE, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(DATADOME, 200, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup(DATADOME, 403, 'text/html')).rejects.toMatchObject({ kind: 'challenge' });
    await expect(lookup('<html><title>Golilla</title></html>', 200, 'text/html')).rejects.toMatchObject({ kind: 'schema' });
    // The service's not-found envelope under HTTP 200 is an unfinished lookup, not a missing parcel.
    await expect(lookup(text('not-found'), 200)).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it('keeps a rate limit with its retry window', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[500, 'indeterminate'], [502, 'indeterminate'], [503, 'maintenance']] as const)(
    'keeps HTTP %s as %s, without a retry', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply('', status));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('tries once more after a failed connection, inside the caller’s budget', async () => {
    const flaky = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(text('delivered')));
    await expect(carrier(flaky).track({ number: DELIVERED })).resolves.toMatchObject({ status: 'delivered' });
    expect(flaky).toHaveBeenCalledTimes(2);
    const slow = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    await expect(carrier(slow).track({ number: DELIVERED }, { budgetMs: 20.5 }))
      .rejects.toMatchObject({ kind: expect.stringMatching(/^(?:transport|budget)$/) });
    expect(slow.mock.calls.length).toBeLessThanOrEqual(2);
    expect(slow.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
  });

  it('takes seven or eight digits without a leading zero, and nothing else, without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['455053', '455053400', '0455053', '00000000', 'SAMPLETRACKING', `${'1'.repeat(70)}`]) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeGolillaNumber(' 4550 534 ')).toBe(DELIVERED);
    expect(normalizeGolillaNumber('45505340')).toBe('45505340');
  });

  it('is asked when the number is filed under Golilla or comes in its tracker’s link', async () => {
    for (const number of [DELIVERED, PARCELS]) expect(detectCarrierMatch(number).carrier, number).not.toBe('golilla');
    expect(parseTrackingInput(`https://my.golilla.it/segui?ldv=${DELIVERED}`)).toMatchObject({ trackingNumber: DELIVERED, carrier: 'golilla' });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => reply(String(url).endsWith(DELIVERED) ? text('delivered') : text('not-found'),
      String(url).endsWith(DELIVERED) ? 200 : 404));
    await expect(createTracker({ fetcher, providers: [], env: {} }).track({ number: DELIVERED, carrier: 'golilla' }, { budgetMs: 3000 }))
      .resolves.toMatchObject({ carrier: 'golilla', source: 'golilla', result: { current_stage: 'delivered' } });
  });
});

type Entry = { code?: string; wording: string; stage?: string; unmapped?: boolean };

describe('Golilla status vocabulary', () => {
  it('maps every code of its list to the stage recorded for it, and leaves the others out on purpose', () => {
    for (const entry of statuses.entries as Entry[]) {
      const code = entry.code!;
      if (entry.unmapped) {
        expect(statusMap.stage(code, entry.wording.toLowerCase()), code).toBeUndefined();
        expect(golillaStage(code, entry.wording), code).toBeNull();
        expect(statusMapAnswer({ carrier: 'golilla', providerCode: code, description: entry.wording }), code)
          .toEqual({ kind: 'intentional_gap', note: expect.any(String) });
        continue;
      }
      expect(statusMap.stage(code, entry.wording.toLowerCase()), code).toBe(entry.stage);
      expect(golillaStage(code, entry.wording), code).toEqual({ stage: entry.stage, source: 'carrier_map' });
    }
    expect(statusMap.gaps.length + (statuses.entries as Entry[]).filter((entry) => !entry.unmapped).length).toBe(statuses.entries.length);
    expect(statusMapAnswer({ carrier: 'golilla', providerCode: '999', description: 'Sample note' })).toEqual({ kind: 'unknown' });
    // A code the list does not hold falls to the shared wording rules.
    expect(golillaStage('999', 'SPEDIZIONE CONSEGNATA')).toEqual({ stage: 'delivered', source: 'wording:language' });
    expect(golillaStage('999', 'Sample note')).toBeNull();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, LaserLogisticsTracker } from './adapter.js';
import { LASER_URL, normalizeLaserNumber, parseLaser } from './parser.js';
import { laserStage, statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// TrackShip's public example, and the unknown number its fixture was asked for.
const DELIVERED = 'MUS11289883';
const UNKNOWN = 'MUS00000000';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const lookup = (body: string, init?: ResponseInit, number = DELIVERED) =>
  carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(body, init))).track({ number });
// The delivered page without the comment that dumps the service's reply.
const tableOnly = () => fixture('delivered').replace(/<!--\s*DATA:[\s\S]*?\n\)\s*-->/, '');

const HISTORY = [
  ['2024-07-24T18:34:00+02:00', 'WBLDLV', 'delivered', 'Delivered'],
  ['2024-07-24T18:34:00+02:00', 'WBLDEB', 'delivered', 'Waybill MUS11289883 Confirmed delivery by driver off delivery sheet ODDBN-00340243'],
  ['2024-07-24T12:00:00+02:00', 'PODCRE', 'delivered', 'POD'],
  ['2024-07-24T08:58:00+02:00', 'WBLALD', 'out_for_delivery', 'In Trip'],
  ['2024-07-24T07:57:00+02:00', 'WBLDAL', 'in_transit', 'On Floor'],
  ['2024-07-23T20:56:00+02:00', 'WBLALL', 'in_transit', 'In Transit'],
  ['2024-07-23T16:53:00+02:00', 'WBLCRE', 'registered', 'Waybill Created'],
];

describe('Laser Logistics HTTP adapter', () => {
  it('asks the tracking page for the whole waybill once, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(fixture('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new LaserLogisticsTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' mus 1128 9883 ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${LASER_URL}?waybillnumber=${DELIVERED}`);
    expect(String(url)).toMatch(/^https:\/\/www\.laserlogistics\.co\.za\/parcel-tracking\/\?/);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'laser-logistics', step: 'direct', outcome: 'ok' }));
  });

  it('reads the service’s reply with its codes on South Africa’s clock, newest first', () => {
    const result = parseLaser(fixture('delivered'), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Delivered', last_update: '2024-07-24T18:34:00+02:00', expected_delivery: null,
      delivered_at: '2024-07-24T12:00:00+02:00', weight_kg: 14.49, service_name: 'ECONOMY ROAD', destination_country: 'ZA' });
    expect(result.events!.map((event) => [event.time, event.provider_code, event.stage, event.description])).toEqual(HISTORY);
    expect(result.events!.every((event) => !event.local_time && !event.location)).toBe(true);
    // The receiver placeholder, the contents, the suburbs and the shipper's reference are not kept.
    expect(JSON.stringify(result)).not.toMatch(/SIGNED|BOX|HALFWAY|PINETOWN|PO106937/);
  });

  it('reads the page’s tables by their wording when the comment is gone', () => {
    const result = parseLaser(tableOnly(), DELIVERED);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', delivered_at: '2024-07-24T12:00:00+02:00',
      weight_kg: 14.49, service_name: 'ECONOMY ROAD' });
    expect(result.events!.map((event) => [event.time, event.provider_code ?? null, event.stage, event.description]))
      .toEqual(HISTORY.map(([time, , stage, description]) => [time, null, stage, description]));
  });

  it('counts a history only for the waybill asked', () => {
    expect(() => parseLaser(fixture('delivered'), 'MUS11289884'))
      .toThrow(expect.objectContaining({ kind: 'indeterminate', message: 'Laser Logistics answered for another waybill' }));
    expect(() => parseLaser(tableOnly(), 'MUS11289884')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLaser(fixture('not-found'), 'MUS00000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads the service’s notice as not found, with or without the comment', () => {
    expect(() => parseLaser(fixture('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const shown = fixture('not-found').replace(/<!--\s*DATA:[\s\S]*?\n\)\s*-->/, '');
    expect(() => parseLaser(shown, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('keeps another error, an empty reply, a changed page and a block page apart from not found', () => {
    const page = fixture('not-found');
    const error = page.replace(/\[pcGeneralError\] => .*/, '[pcGeneralError] => Service temporarily unavailable');
    expect(() => parseLaser(error, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const silent = page.replace(/\[pcGeneralError\] => .*/, '[pcGeneralError] => ');
    expect(() => parseLaser(silent, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseLaser(fixture('delivered').replace('<EventDate>23072024</EventDate>', '<EventDate>2024-07-23</EventDate>'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLaser(fixture('delivered').replace('[pcReturnData]', '[ReturnData]'), DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLaser(page.replace(/<!--\s*DATA:[\s\S]*?\n\)\s*-->/, '').replace(/<p>Waybill[\s\S]*?<\/p>/, ''), UNKNOWN))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseLaser('<html><head><title>Just a moment...</title></head></html>', DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseLaser('<html><title>Laser Logistics</title></html>', DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a moved route and an empty page apart from not found', async () => {
    await expect(lookup(fixture('not-found'), {}, UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    await expect(lookup(fixture('not-found'), { status: 404 }, UNKNOWN)).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('', { status: 301, headers: { Location: '/' } })).rejects.toMatchObject({ kind: 'transport' });
    await expect(lookup('')).rejects.toMatchObject({ kind: 'indeterminate' });
  });

  it.each([[403, 'challenge'], [429, 'rate_limited'], [500, 'indeterminate'], [503, 'maintenance']] as const)(
    'preserves HTTP %s as %s', async (status, kind) => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status }));
      await expect(carrier(fetcher).track({ number: DELIVERED })).rejects.toMatchObject({ kind });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('sends a read that did not reach the site once more', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(fixture('delivered')));
    await expect(carrier(fetcher).track({ number: DELIVERED }, { budgetMs: 2000 })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends only a whole waybill number', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const number of ['MUS1', 'MUSABCDEF', 'MUS11289883%', 'MUS-1128*', 'M'.repeat(21) + '1']) {
      await expect(carrier(fetcher).track({ number }), number).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(carrier(fetcher).recognize!(number), number).resolves.toEqual({ known: false });
    }
    await expect(carrier(fetcher).track({ number: DELIVERED }, { signal: AbortSignal.abort(new Error('cancelled')) })).rejects.toThrow('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(normalizeLaserNumber('mus-1128-9883')).toBe(DELIVERED);
  });

  it('recognizes a known waybill by its last scan and an unknown one by the notice', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      reply(fixture(String(url).endsWith(DELIVERED) ? 'delivered' : 'not-found')));
    await expect(carrier(fetcher).recognize!(DELIVERED)).resolves.toEqual({ known: true, lastActivityAt: '2024-07-24T16:34:00.000Z', finished: true });
    await expect(carrier(fetcher).recognize!(UNKNOWN)).resolves.toEqual({ known: false });
  });
});

describe('Laser Logistics numbers', () => {
  it('claims no waybill shape: one aggregator example is no rule', () => {
    const match = detectCarrierMatch(DELIVERED);
    expect(match.carrier).not.toBe('laser-logistics');
    expect(match.candidates).not.toContain('laser-logistics');
  });
});

describe('Laser Logistics status vocabulary', () => {
  it('records every code and wording the map knows with the stage it gives', () => {
    for (const entry of statuses.entries as { code?: string; wording: string; stage: string }[]) {
      expect(statusMap.stage(entry.code ?? null, entry.wording), entry.wording).toBe(entry.stage);
      expect(statusMap.stage(null, entry.wording), entry.wording).toBe(entry.stage);
      expect(laserStage(entry.code ?? '', entry.wording)?.stage, entry.wording).toBe(entry.stage);
    }
    // A code the map does not know falls to the shared wording rules.
    expect(laserStage('XYZ', 'Out for delivery')).toEqual({ stage: 'out_for_delivery', source: 'wording:language' });
    expect(laserStage('XYZ', 'Synthetic note')).toBeNull();
  });
});

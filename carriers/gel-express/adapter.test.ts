import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { InvalidInputError, UpstreamNetworkError } from '../../core/errors/index.js';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, GEL_TRACKING, GelTracker, gelTrackingUrl } from './adapter.js';
import { normalizeGelNumber, parseGel } from './parser.js';
import { gelStage } from './status.js';
import numbers from './numbers.json' with { type: 'json' };
import statuses from './statuses.json' with { type: 'json' };

// The review's parcel, whose page the delivered fixture keeps.
const DELIVERED = numbers.records.find((record) => record.source.url.includes('trustpilot'))!.number;
const UNKNOWN = '9999999990';
const html = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const delivered = html('delivered');
const absent = html('not-found');
const edit = (change: (document: ReturnType<typeof load>) => void, body = delivered) => {
  const $ = load(body);
  change($);
  return $.html();
};
const status = (wording: string, clock = '21.05.2026 um 14:10 Uhr') => edit(($) => {
  $('.rightBox h4.red').first().text(wording);
  $('.rightBox td').filter((_, td) => $(td).text().trim() === 'Status vom').next().text(clock);
});
const reply = (body = delivered, code = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status: code, headers: { 'Content-Type': 'text/html', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('GEL Express tracking adapter', () => {
  it('reads a delivered parcel\'s current status on Berlin\'s clock', () => {
    const result = normalizeCarrierResult(parseGel(delivered, DELIVERED));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Sendung zugestellt', last_update: '2026-05-21T14:10:00+02:00', expected_delivery: null,
      delivered_at: '2026-05-21T14:10:00+02:00' });
    expect(result.events).toEqual([{ time: '2026-05-21T14:10:00+02:00', description: 'Sendung zugestellt', stage: 'delivered',
      stage_source: 'carrier_map' }]);
    // The shipper's reference, the ship date and the piece count stay out.
    expect(JSON.stringify(result)).not.toMatch(/25686|2026-04-30/);
  });

  it('asks the page for the number, typed with spaces or not', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply());
    const spaced = DELIVERED.replace(/^(\d{4})(\d{3})/, '$1 $2 ');
    for (const typed of [DELIVERED, spaced]) {
      await expect(carrier(fetcher).track({ number: typed })).resolves.toMatchObject({ status: 'delivered' });
    }
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${GEL_TRACKING}?snr=${DELIVERED}`, `${GEL_TRACKING}?snr=${DELIVERED}`]);
    expect(gelTrackingUrl(DELIVERED)).toBe(`https://www.gel-express.de/de/sendungsverfolgung/?snr=${DELIVERED}`);
  });

  it('dates a winter status on standard time and the repeated hour as its first occurrence', () => {
    expect(parseGel(status('Sendung in Zustellung', '2.1.2026 um 7:45 Uhr'), DELIVERED)).toMatchObject({
      status: 'out_for_delivery', current_stage: 'out_for_delivery', last_update: '2026-01-02T07:45:00+01:00' });
    expect(parseGel(status('Sendung im Zustelldepot', '25.10.2026 um 02:30 Uhr'), DELIVERED).last_update).toBe('2026-10-25T02:30:00+02:00');
  });

  it('keeps a status neither map knows without a stage', () => {
    const result = parseGel(status('Sendung beim Partner'), DELIVERED);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Sendung beim Partner' });
    expect(result).not.toHaveProperty('current_stage');
    expect(result).not.toHaveProperty('delivered_at');
  });

  it('answers not found only when the notice holds the number asked', async () => {
    expect(() => parseGel(absent, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseGel(absent, '9999999991')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    await expect(carrier(vi.fn<typeof fetch>(async () => reply(absent))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('rejects a page for another parcel, or with two, as inconclusive', () => {
    const other = edit(($) => { $('#tsnr').text('1234567890'); });
    expect(() => parseGel(other, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const otherForm = edit(($) => { $('input#snr').attr('value', '1234567890'); });
    expect(() => parseGel(otherForm, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const twice = edit(($) => { $('#tsnr').after('<h4 id="tsnr">1234567890</h4>'); });
    expect(() => parseGel(twice, DELIVERED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('fails on a page without its status or time instead of guessing', () => {
    const noStatus = edit(($) => { $('.rightBox table').remove(); });
    expect(() => parseGel(noStatus, DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGel(status('Sendung zugestellt', 'gestern'), DELIVERED)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseGel('<html><body><main>Wartungsarbeiten</main></body></html>', DELIVERED))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps a browser check or a refusal apart from a missing parcel', async () => {
    const check = '<html><head><title>Just a moment...</title></head><body>_cf_chl_opt</body></html>';
    expect(() => parseGel(check, DELIVERED)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    await expect(carrier(vi.fn<typeof fetch>(async () => reply(check, 403, { 'cf-mitigated': 'challenge' }))).track({ number: DELIVERED }))
      .rejects.toMatchObject({ kind: 'challenge' });
    await expect(new GelTracker({ fetcher: vi.fn<typeof fetch>(async () => reply('denied', 403)) }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'transport' });
    await expect(new GelTracker({ fetcher: vi.fn<typeof fetch>(async () => reply('', 301, { Location: '/' })) }).fetch(DELIVERED))
      .rejects.toMatchObject({ kind: 'transport' });
  });

  it('tries once more after a network failure', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new UpstreamNetworkError('GEL Express', 'socket hang up'))
      .mockResolvedValueOnce(reply());
    await expect(new GelTracker({ fetcher }).fetch(DELIVERED)).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects anything but ten digits without a request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const typed of ['238759530', '23875953080', 'GEL2387595308', '']) {
      expect(() => normalizeGelNumber(typed)).toThrow(InvalidInputError);
      await expect(carrier(fetcher).track({ number: typed })).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded wording to its stage', () => {
    for (const entry of statuses.entries) {
      expect(gelStage(entry.wording)?.stage, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'gel-express', providerCode: null, description: entry.wording }), entry.wording)
        .toEqual({ kind: 'mapped', stage: entry.stage });
    }
    expect(statusMapAnswer({ carrier: 'gel-express', providerCode: 'X', description: 'Sendung zugestellt' })).toEqual({ kind: 'unknown' });
    expect(gelStage('Sendung teleportiert')).toBeNull();
  });
});

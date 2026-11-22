import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CORREOS_PANAMA_ITEM, CorreosPanamaTracker } from './adapter.js';
import { correosPanamaItemUrl, normalizeCorreosPanamaNumber, parseCorreosPanamaItem } from './parser.js';
import { correosPanamaStage } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample: an EMS item posted in Panama and delivered in Canada.
const EMS = 'ED100265337PA';
const UNKNOWN = 'RR999999995PA';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const reply = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
// One row of the page's history, as the page writes it.
const row = (clock: string, country: string, office: string, event: string, extra = '') => `<tr class="tabl1">
<td align="center" width="10%">${clock}</td><td align="center" width="10%">${country}</td><td align="center" width="10%">${office}</td>
<td align="center" width="15%">${event}</td><td align="center" width="10%">A</td><td align="center" width="15%"> </td>
<td align="center" width="15%">${extra}</td><td align="center" width="10%"> </td></tr>`;
// The sample's page with these rows instead of its own.
const withRows = (rows: string) => page('delivered').replace(/(Extra Information<\/td>[\s\S]*?<\/tr>)[\s\S]*?(<\/tbody>)/, `$1${rows}$2`);
const BLOCKED = '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Sorry, you have been blocked</body></html>';

describe('Correos Panamá tracking adapter', () => {
  it('opens the page for the whole code once, as the tracker\'s form does, through the supplied transport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(page('delivered')));
    const recorder = { ...NOOP_RECORDER, step: vi.fn(), lookup: vi.fn() };
    await expect(new CorreosPanamaTracker({ fetcher, recorder, userAgent: 'SyntheticHost/1.0' }).fetch(' ed 100 265 337 pa ', { budgetMs: 1000.5 }))
      .resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${CORREOS_PANAMA_ITEM}?itemid=${EMS}`);
    expect(String(url)).toBe(correosPanamaItemUrl(EMS));
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'SyntheticHost/1.0' } });
    expect(recorder.step).toHaveBeenCalledWith(expect.objectContaining({ carrier: 'correos-panama', step: 'direct', outcome: 'ok' }));
    expect(recorder.lookup).toHaveBeenCalledTimes(1);
  });

  it('reads an item delivered abroad newest first, Panama\'s scans on its clock and the Canadian ones on their own', () => {
    const result = parseCorreosPanamaItem(page('delivered'), EMS);
    // The delivery abroad has no offset, so it gives no delivery instant.
    expect(result).toEqual({ status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Deliver item (Inb)', last_update: null, last_update_local: '2026-06-23T09:27:00', expected_delivery: null,
      destination_country: 'CA', events: expect.any(Array) });
    expect(result.events!.map((event) => [event.time ?? event.local_time, event.location, event.description, event.stage])).toEqual([
      // Who signed is dropped.
      ['2026-06-23T09:27:00', 'J7V, Canada', 'Deliver item (Inb)', 'delivered'],
      ['2026-06-23T07:21:00', 'J7V, Canada', 'Send item out for physical delivery (Inb)', 'out_for_delivery'],
      ['2026-06-23T00:16:00', 'J7V, Canada', 'Receive item at delivery office (Inb)', 'in_transit'],
      ['2026-06-22T17:52:00', 'Fresne-Saint-Mames, Canada', 'Receive item at sorting centre (Inb)', 'in_transit'],
      ['2026-06-22T04:06:00', 'Chemille-sur-Deme, Canada', 'Send item out of sorting centre (Inb)', 'in_transit'],
      ['2026-06-21T18:07:00', 'Chemille-sur-Deme, Canada', 'Receive item at sorting centre (Inb)', 'in_transit'],
      ['2026-06-21T16:01:00', 'TORONTO-A, Canada', 'Send item to domestic location (Inb)', 'in_transit'],
      ['2026-06-21T16:00:00', 'TORONTO-A, Canada', 'Return item from customs (Inb)', 'in_transit'],
      ['2026-06-21T15:58:00', 'TORONTO-A, Canada', 'Send item to customs (Inb)', 'customs'],
      ['2026-06-21T15:58:00', 'TORONTO-A, Canada', 'Receive item at office of exchange (Inb)', 'in_transit'],
      ['2026-04-23T13:24:23-05:00', 'PANAMA EMS, Panama', 'Enviado a Destino (Otb)', 'in_transit'],
      ['2026-04-23T13:18:00-05:00', 'PANAMA EMS, Panama', 'recibir el artículo en la oficina de cambio (Otb)', 'in_transit'],
      ['2026-04-22T08:26:55-05:00', 'Los Pueblos, Panama', 'Send item to domestic location (Otb)', 'in_transit'],
      ['2026-04-22T08:11:10-05:00', 'Los Pueblos, Panama', 'Recibe elemento de cliente (Otb)', 'accepted'],
    ]);
    expect(result.events!.filter((event) => event.local_time).every((event) => !event.time)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SIGNED BY/);
  });

  it('reads the reason a delivery failed and the delivery instant in Panama', () => {
    const result = parseCorreosPanamaItem(withRows([
      row('11/02/2026 9:05:00 a. m.', 'Panama', 'PANAMA 0815', 'Unsuccessful item delivery attempt (Inb)',
        'Reason : Addressee absent<br>Measure : Item held at the delivery office<br>SIGNED BY : SAMPLE PERSON'),
      row('11/03/2026 12:30:00 p. m.', 'Panama', 'PANAMA 0815', 'Deliver item (Inb)'),
    ].join('')), EMS);
    expect(result).toMatchObject({ status: 'delivered', delivered_at: '2026-11-03T12:30:00-05:00', last_update: '2026-11-03T12:30:00-05:00',
      destination_country: 'PA' });
    expect(result.events![1]).toMatchObject({ time: '2026-11-02T09:05:00-05:00', location: 'Panama', stage: 'failed_attempt',
      description: 'Unsuccessful item delivery attempt (Inb): Addressee absent; Item held at the delivery office' });
    expect(JSON.stringify(result)).not.toMatch(/SAMPLE PERSON|0815/);
  });

  it('reads the notice for a code the tracker holds nothing for as not found', async () => {
    expect(() => parseCorreosPanamaItem(page('not-found'), UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page('not-found')))).track({ number: UNKNOWN }))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(page('not-found')))).recognize!(UNKNOWN))
      .resolves.toMatchObject({ known: false });
  });

  it('refuses another item, changed columns, rows and clocks, and a block page', () => {
    expect(() => parseCorreosPanamaItem(page('delivered'), 'ED100265345PA')).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosPanamaItem(page('delivered').replace('Mail Category', 'Category'), EMS)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosPanamaItem(withRows(row('13/22/2026 8:11:10 a. m.', 'Panama', 'Los Pueblos', 'Deliver item (Inb)')), EMS))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosPanamaItem(withRows(row('04/22/2026 13:11:10 p. m.', 'Panama', 'Los Pueblos', 'Deliver item (Inb)')), EMS))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosPanamaItem(withRows(row('04/22/2026 8:11:10 a. m.', 'Panama', 'Los Pueblos', '')), EMS))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosPanamaItem(withRows('<tr><td>04/22/2026 8:11:10 a. m.</td></tr>'), EMS)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCorreosPanamaItem(withRows(''), EMS)).toThrow(expect.objectContaining({ name: 'NoHistoryError' }));
    expect(() => parseCorreosPanamaItem(BLOCKED, EMS)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseCorreosPanamaItem('<html><title>IPS</title></html>', EMS)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the AM marker in English as well', () => {
    const result = parseCorreosPanamaItem(withRows(row('04/22/2026 12:11:10 AM', 'Panama', 'Los Pueblos', 'Receive item from customer (Otb)')), EMS);
    expect(result.events).toEqual([expect.objectContaining({ time: '2026-04-22T00:11:10-05:00', stage: 'accepted' })]);
  });

  it('keeps redirects, missing routes and rate limits apart from a missing item, and retries a network failure once', async () => {
    for (const status of [302, 404]) {
      await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('', status, { Location: '/' }))).track({ number: EMS }))
        .rejects.toMatchObject({ kind: 'transport' });
    }
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply('', 429))).track({ number: EMS })).rejects.toMatchObject({ kind: 'rate_limited' });
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(reply(page('delivered')));
    await expect(carrier(fetcher).track({ number: EMS })).resolves.toMatchObject({ status: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('takes S10 codes with a valid check digit and refuses anything else before a request', async () => {
    expect(normalizeCorreosPanamaNumber('ed100265337pa')).toBe(EMS);
    expect(normalizeCorreosPanamaNumber('RR999999995PA')).toBe(UNKNOWN);
    for (const bad of ['ED100265338PA', 'ED10026533PA', '1234567890', 'X'.repeat(65)]) {
      expect(() => normalizeCorreosPanamaNumber(bad)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: 'ED100265338PA' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps every recorded event name to its stage', () => {
    for (const entry of statuses.entries) {
      expect(correosPanamaStage(entry.wording)?.stage ?? null, entry.wording).toBe(entry.stage);
      expect(statusMapAnswer({ carrier: 'correos-panama', description: entry.wording })).toEqual({ kind: 'mapped', stage: entry.stage });
    }
  });
});

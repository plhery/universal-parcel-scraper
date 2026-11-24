import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, derKurierOrderFindUrl, derKurierTrackerUrl } from './adapter.js';
import { derKurierGlsForm, normalizeDerKurierNumber, parseDerKurier, readDerKurierOrderFind } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's page, and the answers for an invented number: the tracker's page, which
// shows another parcel, and the order service's answer that it holds no order under it.
const SAMPLE = '48800015025';
const INVENTED = '99999999999';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });
const cell = (text: string) => `<td>${text}</td>`;
const row = (parcel: string, day: string, time: string, remark: string, status: string) =>
  `<tr class="sendeverfolgung_tabelle_item_row">${[parcel, day, time, remark, status].map(cell).join('')}</tr>`;
/** A page for `number` with only these rows under the table's header. */
const page = (number: string, ...rows: string[]) => fixture(`${SAMPLE}.html`)
  .replace(`parcel=${SAMPLE}`, `parcel=${number}`)
  .replace(/(<tr class="sendeverfolgung_tabelle_first_row">[\s\S]*?<\/tr>)[\s\S]*?(<\/table>)/, `$1${rows.join('')}$2`)
  .replace(/\d+ Ergebnisse/, `${rows.length} Ergebnisse`);
const noOrder = (number: string) => json(JSON.stringify({ type: 'about:blank', status: 404, detail: `No order for parcel-no ${number.replace(/^0+/, '')}` }), 404);

describe('DER KURIER numbers', () => {
  it('takes eleven digits, or twelve without their check digit', () => {
    expect(normalizeDerKurierNumber(` ${SAMPLE} `)).toBe(SAMPLE);
    expect(normalizeDerKurierNumber('488 000 150 25')).toBe(SAMPLE);
    expect(normalizeDerKurierNumber(`${SAMPLE}7`)).toBe(SAMPLE);
    for (const other of ['', '4880001502', '4880001502577', '020_241014002354', '900:250421000535', 'ABCDEFGHIJK', '9'.repeat(70)]) {
      expect(() => normalizeDerKurierNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('moves the 8 of a number with 8 and 5 third and fourth to the front, as the widget does', () => {
    expect(derKurierGlsForm('54852333475')).toBe('85452333475');
    expect(derKurierGlsForm(SAMPLE)).toBe(SAMPLE);
  });
});

describe('DER KURIER tracking adapter', () => {
  it('reads the tracker’s page for the number', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(fixture(`${SAMPLE}.html`)));
    await expect(carrier(fetcher).track({ number: `${SAMPLE}7` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://leotrace.derkurier.de/paketstatus.aspx?Lang=DE&parcel=${SAMPLE}`);
    expect(derKurierTrackerUrl(SAMPLE)).toBe(String(url));
    expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal), headers: expect.objectContaining({ 'User-Agent': expect.any(String) }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'der-kurier', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('refuses a number outside DER KURIER’s layout without asking', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(carrier(fetcher).track({ number: '020_241014002354' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a page that lists only another parcel as not found when the order service holds no order either', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => html(fixture('not-found.html')))
      .mockImplementationOnce(async () => json(fixture('not-found.json'), 404));
    await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([derKurierTrackerUrl(INVENTED), derKurierOrderFindUrl(INVENTED)]);
    expect(derKurierOrderFindUrl(INVENTED)).toBe(`https://api.derkurier.de/rs/api/v1/order/find?parcel-no=${INVENTED}&archive=true`);
  });

  it('asks the order service for the GLS form too, as the widget does, before calling a number not found', async () => {
    const asked = '12852333475';
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => html(page(asked, row('40000000000', '13.07.2022', '07:54', '', 'Ausgeliefert'))))
      .mockImplementationOnce(async () => noOrder(asked))
      .mockImplementationOnce(async () => noOrder('81252333475'));
    await expect(carrier(fetcher).track({ number: asked })).rejects.toMatchObject({ kind: 'not_found' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      derKurierTrackerUrl(asked), derKurierOrderFindUrl(asked), derKurierOrderFindUrl('81252333475')]);
  });

  it('reads an order the service holds without a row on the tracker as a listed parcel', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => html(fixture('not-found.html')))
      .mockImplementationOnce(async () => json('123456789'));
    await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'indeterminate', reason: 'listed' });
  });

  it('keeps refusals, outages, redirects and changed replies apart from a missing parcel', async () => {
    const answer = async (...responses: (() => Response)[]) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const response of responses) fetcher.mockImplementationOnce(async () => response());
      return carrier(fetcher).track({ number: INVENTED }, { budgetMs: 2000 }).catch((error: unknown) => error);
    };
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>Request Rejected</title>', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: '/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => json('{}'))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => html('<html><body>Wartungsarbeiten</body></html>'))).toMatchObject({ kind: 'schema' });
    for (const service of [() => json('', 500), () => html('<html></html>', { status: 404 }), () => json('{"status":404,"detail":"No order for parcel-no 1"}', 404),
      () => json('{"status":400,"detail":"Reference value invalid"}', 400)]) {
      expect(await answer(() => html(fixture('not-found.html')), service)).not.toMatchObject({ kind: 'not_found' });
    }
  });
});

describe('DER KURIER pages', () => {
  it('reads the public sample: its rows on the station’s wall clock, newest first', () => {
    expect(parseDerKurier(fixture(`${SAMPLE}.html`), SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Ausgeliefert', last_update: null, last_update_local: '2025-01-14T14:28:00', expected_delivery: null,
      events: [
        { local_time: '2025-01-14T14:28:00', description: 'Ausgeliefert', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2025-01-14T08:11:00', description: 'Zustellhindernis: Kunde nicht angetroffen', stage: 'failed_attempt', stage_source: 'carrier_map' },
        { local_time: '2025-01-14T07:20:00', description: 'in Zustellung', stage: 'out_for_delivery', stage_source: 'carrier_map' },
        { local_time: '2025-01-14T06:54:00', description: 'Eingang Import', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-01-14T02:02:00', description: 'HUB beladen', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-01-14T00:03:00', description: 'HUB entladen', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-01-13T18:58:00', description: 'Linie beladen', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-01-13T18:36:00', description: 'Export verladen', stage: 'in_transit', stage_source: 'carrier_map' },
        { local_time: '2025-01-13T18:36:00', description: 'Eingang Export', stage: 'accepted', stage_source: 'carrier_map' },
        { local_time: '2025-01-13T11:45:00', description: 'Daten erfasst', stage: 'registered', stage_source: 'carrier_map' },
      ],
    });
  });

  it('gives null for a page that lists only another parcel, which the tracker shows for any number it lacks', () => {
    expect(parseDerKurier(fixture('not-found.html'), INVENTED)).toBeNull();
    expect(parseDerKurier(page(INVENTED), INVENTED)).toBeNull();
  });

  it('reads the rows under the number’s GLS form when none are under the number', () => {
    const gls = page('54852333475', row('99010402556', '19.07.2022', '13:32', '', 'HUB beladen'),
      row('85452333475', '11.07.2022', '09:17', 'Empfänger nicht angetroffen', 'Zustellhindernis'), row('', '11.07.2022', '06:43', '', 'in Zustellung'));
    expect(parseDerKurier(gls, '54852333475')).toMatchObject({ current_stage: 'failed_attempt', last_update_local: '2022-07-11T09:17:00', events: [
      { local_time: '2022-07-11T09:17:00', description: 'Zustellhindernis: Empfänger nicht angetroffen' },
      { local_time: '2022-07-11T06:43:00', description: 'in Zustellung' },
    ] });
  });

  it('keeps the newest parcel of a reused number and never reads a driver’s free text', () => {
    const reused = page('02060111854',
      row('02060111854', '27.11.2023', '10:28', '', 'Ausgeliefert'), row('', '24.11.2023', '07:27', '', 'Daten erfasst'),
      row('', '20.08.2019', '12:37', 'Name: x - Grund: Synthetic Recipient refused', 'Zustellhindernis'), row('', '19.08.2019', '16:52', '', 'Daten erfasst'));
    expect(parseDerKurier(reused, '02060111854')?.events?.map((event) => event.local_time)).toEqual(['2023-11-27T10:28:00', '2023-11-24T07:27:00']);
    const remark = page(SAMPLE, row(SAMPLE, '20.08.2019', '12:37', 'Name: x - Grund: Synthetic Recipient refused', 'Zustellhindernis'),
      row('', '20.08.2019', '12:36', 'Retoure', 'Zustellhindernis'), row('', '20.08.2019', '07:05', '', 'Rollkartenscan'));
    expect(parseDerKurier(remark, SAMPLE)?.events?.map((event) => event.description)).toEqual(['Zustellhindernis', 'Zustellhindernis: Retoure', 'Rollkartenscan']);
  });

  it('refuses a page for another number and a changed page', () => {
    expect(() => parseDerKurier(fixture(`${SAMPLE}.html`), INVENTED)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    for (const changed of [
      fixture(`${SAMPLE}.html`).replace('10 Ergebnisse', '9 Ergebnisse'),
      fixture(`${SAMPLE}.html`).replace(/<span id="lblMeldung">[^<]*<\/span>/, ''),
      fixture(`${SAMPLE}.html`).replace('<td>Bemerkung</td>', '<td>Ort</td>'),
      page(SAMPLE, row(SAMPLE, '14.01.2025', '14:28', '', '')),
      page(SAMPLE, row(SAMPLE, '2025-01-14', '14:28', '', 'Ausgeliefert')),
      page(SAMPLE, row(SAMPLE, '31.02.2025', '14:28', '', 'Ausgeliefert')),
      page(SAMPLE, row('', '14.01.2025', '14:28', '', 'Ausgeliefert')),
      page(SAMPLE, `<tr>${cell(SAMPLE)}${cell('14.01.2025')}${cell('Ausgeliefert')}</tr>`),
      fixture(`${SAMPLE}.html`).replace(/<form\b[^>]*>/, '<form method="post">'),
    ]) expect(() => parseDerKurier(changed, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('reads the order service’s answer only when it names the number asked', () => {
    expect(readDerKurierOrderFind(404, fixture('not-found.json'), INVENTED)).toBe('none');
    expect(readDerKurierOrderFind(404, '{"type":"about:blank","status":404,"detail":"No order for parcel-no 2060111854"}', '02060111854')).toBe('none');
    expect(readDerKurierOrderFind(200, '123456789', INVENTED)).toBe('listed');
    for (const [status, body] of [[404, '{"status":404,"detail":"No order for parcel-no 99999999998"}'], [404, 'Not Found'], [400, '{"status":400}']] as const) {
      expect(() => readDerKurierOrderFind(status, body, INVENTED), body).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('answers each wording statuses.json records by its stage', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'der-kurier', providerCode: null, description: wording }), wording).toEqual({ kind: 'mapped', stage });
    }
  });
});

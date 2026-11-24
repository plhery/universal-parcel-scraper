import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, KARGOLIFE_TRACKER } from './adapter.js';
import { kargolifeWindow, normalizeKargolifeNumber, parseKargolife } from './parser.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample's reply and the reply for an invented number; the tests derive other orders from the sample.
const SAMPLE = '11271780681';
const INVENTED = '99999999901';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture(`order-${SAMPLE}`);
const NOT_FOUND = fixture('not-found');
const STEPS = ['Siparişiniz alındı', 'Hazırlanıyor', 'Teslimat deposunda', 'Dağıtıma Hazır', 'Teslim edildi'];
/** The sample's page with its steps drawn in these classes, and its window written as given. */
const page = (classes: string[], window = '08 - 13/06/2026') => {
  let index = 0;
  return DELIVERED
    .replace(/<div class="explanation c[1-4]">([^<]*)<\/div>/g, (_whole, text: string) => `<div class="explanation ${classes[index++]}">${text}</div>`)
    .replace(/(<div class="explanation c5">)\s*[^<]*?\s*(<\/div>)/, `$1\n${window}\n$2`);
};
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Kargolife numbers', () => {
  it('takes an order number of digits, with or without a leading #', () => {
    expect(normalizeKargolifeNumber(` #${SAMPLE} `)).toBe(SAMPLE);
    expect(normalizeKargolifeNumber('112 7178 0681')).toBe(SAMPLE);
    for (const other of ['', '12345', 'ABC12345678', '1'.repeat(21), '1127178068%']) {
      expect(() => normalizeKargolifeNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Kargolife tracking adapter', () => {
  it('posts the tracker’s form with the number alone', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(DELIVERED));
    await expect(carrier(fetcher).track({ number: `#${SAMPLE}` })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(KARGOLIFE_TRACKER);
    expect(init).toMatchObject({ method: 'POST', body: `numberOfOrder=${SAMPLE}`, redirect: 'manual', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }) });
    expect(carrier(fetcher)).toMatchObject({ id: 'kargolife', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s notice as not found', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => html(NOT_FOUND));
    await expect(carrier(fetcher).track({ number: INVENTED })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps refusals, error pages, checks and redirects apart from a missing order', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: INVENTED }, { budgetMs: 2000 }).catch((error: unknown) => error);
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<title>500</title>', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><title>Just a moment...</title></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('<html><body><div class="g-recaptcha"></div></body></html>'))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => new Response(null, { status: 302, headers: { Location: 'https://kargolife.com/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('<html><body>Bakımdayız</body></html>'))).toMatchObject({ kind: 'schema' });
  });
});

describe('Kargolife replies', () => {
  it('reads the public sample: the step it has reached, without the window it was planned in', () => {
    expect(parseKargolife(DELIVERED, SAMPLE)).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map',
      last_status_text: 'Teslim edildi', last_update: null, expected_delivery: null, summary_only: true, events: [],
    });
  });

  it('reads an order on its way by its orange step, with its delivery window', () => {
    expect(parseKargolife(page(['c4', 'c4', 'c2', 'c3', 'c3']), SAMPLE)).toMatchObject({
      status: 'in_transit', current_stage: 'in_transit', last_status_text: 'Teslimat deposunda',
      expected_delivery_from: '2026-06-08', expected_delivery: '2026-06-13', summary_only: true, events: [],
    });
    expect(parseKargolife(page(['c2', 'c3', 'c3', 'c3', 'c3'], '28 - 02/06/2025'), SAMPLE)).toMatchObject({
      status: 'pending', current_stage: 'registered', expected_delivery_from: '2025-05-28', expected_delivery: '2025-06-02',
    });
    // A window it cannot read is named for later rather than guessed.
    expect(parseKargolife(page(['c4', 'c2', 'c3', 'c3', 'c3'], 'Haziran sonu'), SAMPLE)).toMatchObject({
      current_stage: 'registered', expected_delivery: null, unread_estimates: ['Tahmini Teslimat Tarihi'],
    });
  });

  it('writes a window as the tracker does, its first day in the month before when it is the later day', () => {
    expect(kargolifeWindow('08 - 13/06/2026')).toEqual({ from: '2026-06-08', to: '2026-06-13' });
    expect(kargolifeWindow('28 - 02/06/2025')).toEqual({ from: '2025-05-28', to: '2025-06-02' });
    expect(kargolifeWindow('29 - 03/01/2026')).toEqual({ from: '2025-12-29', to: '2026-01-03' });
    expect(kargolifeWindow('28/12 - 02/01/2026')).toEqual({ from: '2025-12-28', to: '2026-01-02' });
    expect(kargolifeWindow('30/06/2026 - 02/07/2026')).toEqual({ from: '2026-06-30', to: '2026-07-02' });
    for (const text of ['', '13/06/2026', '31 - 02/03/2026', '08 - 32/06/2026', '08/06/2026 - 01/06/2026']) expect(kargolifeWindow(text), text).toBeNull();
  });

  it('stages every step the tracker draws, and leaves a step it never drew without a stage', () => {
    for (const { wording, stage } of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'kargolife', providerCode: null, description: wording })).toEqual({ kind: 'mapped', stage });
    }
    expect(statuses.entries.map((entry) => entry.wording)).toEqual(STEPS);
    const unknown = parseKargolife(page(['c4', 'c4', 'c4', 'c4', 'c2']).replace('>Teslim edildi<', '>İade edildi<'), SAMPLE);
    expect(unknown).toMatchObject({ status: 'unknown', last_status_text: 'İade edildi' });
    expect(unknown).not.toHaveProperty('current_stage');
  });

  it('refuses a changed page', () => {
    for (const changed of [
      '<html><body>Bakımdayız</body></html>',
      DELIVERED.replace(/<div class="explanation c[0-9]">[^<]*<\/div>/g, ''),
      page(['c4', 'c4', 'c4', 'c4', 'c4']),
      page(['c2', 'c2', 'c4', 'c4', 'c4']),
      page(['c4', 'c4', 'c4', 'c4', 'c7']),
      DELIVERED.replace('Tahmini Teslimat Tarihi', 'Teslimat'),
      NOT_FOUND.replace(NOT_FOUND.match(/Sipari\S+ bulunamad\S+/)![0], 'Hata'),
      DELIVERED.replace('name="numberOfOrder"', 'name="order"'),
    ]) {
      expect(() => parseKargolife(changed, SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });
});

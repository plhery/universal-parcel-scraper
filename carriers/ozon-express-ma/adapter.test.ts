import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, OZON_LOOKUP } from './adapter.js';
import { normalizeOzonNumber, parseOzon } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and an invented number the tracker does not know.
const SAMPLE = 'MRK062629425421RX';
const OTHER = 'ZZZ000000000ZZ';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
// The tracker echoes the number in the case it was sent; the fixture's request kept the reviewer's.
const DELIVERED = fixture('delivered').replace('MRK062629425421Rx', SAMPLE);
const NOT_FOUND = fixture('not-found');
// The tracker labels its HTML card as JSON.
const reply = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('Ozon Express numbers', () => {
  it('takes letters and digits with at least one digit, in capitals', () => {
    expect(normalizeOzonNumber(` ${SAMPLE.toLowerCase()} `)).toBe(SAMPLE);
    expect(normalizeOzonNumber('123456789')).toBe('123456789');
    for (const other of ['', 'MRK01', 'ABCDEFGHIJ', `${SAMPLE};${OTHER}`, 'MRK/062629425', 'M'.repeat(40) + '1', 'M'.repeat(65)]) {
      expect(() => normalizeOzonNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('Ozon Express tracking adapter', () => {
  it('posts the number as the tracking box does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE.toLowerCase() })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(OZON_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal) });
    expect((init.body as FormData).get('tracking-number')).toBe(SAMPLE);
    expect(carrier(fetcher)).toMatchObject({ id: 'ozon-express-ma', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the tracker’s answer for an unknown number as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(reply(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, other refusals, redirects and changed replies apart from a missing parcel', async () => {
    const answer = async (response: () => Response) => carrier(vi.fn<typeof fetch>().mockImplementation(async () => response()))
      .track({ number: OTHER }, { budgetMs: 2000 }).catch((error: unknown) => error);
    const challenge = '<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>';
    expect(await answer(() => html(challenge, { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge, { status: 503 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html(challenge))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('Forbidden', { status: 403 }))).toMatchObject({ kind: 'challenge' });
    expect(await answer(() => html('', { status: 503 }))).toMatchObject({ kind: 'maintenance' });
    expect(await answer(() => html('', { status: 429 }))).toMatchObject({ kind: 'rate_limited' });
    expect(await answer(() => html('<h1>Not Found</h1>', { status: 404 }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://ozonexpress.ma/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('Internal error', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => reply(''))).toMatchObject({ kind: 'schema' });
    expect(await answer(() => reply('{"error":"invalid"}'))).toMatchObject({ kind: 'schema' });
    // The not-found card without its notice is a changed reply.
    expect(await answer(() => reply(NOT_FOUND.replace('هذا الرقم غير موجود', '')))).toMatchObject({ kind: 'schema' });
  });
});

describe('Ozon Express replies', () => {
  it('reads the public sample: delivered, oldest step last, on the wall clocks the card shows', () => {
    const result = parseOzon(DELIVERED, SAMPLE);
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Livré',
      last_update: null, last_update_local: '2026-06-28T17:12:00', expected_delivery: null,
    });
    expect((result.events ?? []).map((event) => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-06-28T17:12:00', 'Livré', 'delivered'],
      ['2026-06-28T09:12:00', 'Mise en distribution', 'out_for_delivery'],
      ['2026-06-28T06:45:00', 'Reçu', 'in_transit'],
      ['2026-06-28T01:21:00', 'Expédié', 'in_transit'],
      ['2026-06-27T21:18:00', 'Ramassé', 'accepted'],
      ['2026-06-27T16:36:00', 'Ramassé', 'accepted'],
    ]);
    // The payment state in the card's comments is never read.
    expect(JSON.stringify(result)).not.toMatch(/Payé/);
  });

  it('reads a card for another number as an open answer', () => {
    expect(() => parseOzon(DELIVERED, 'MRK062629425421RY')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads a card without dated steps by its current status, else as no history', () => {
    const bare = DELIVERED.replace(/<div class="tracking-timeline">[\s\S]*$/, '<div class="tracking-timeline">Aucun historique</div></div></div></div>');
    expect(parseOzon(bare, SAMPLE)).toMatchObject({
      status: 'delivered', current_stage: 'delivered', last_status_text: 'Livré', last_update_local: '2026-06-28T17:12:00', summary_only: true, events: [],
    });
    const unknown = bare.replace('<p>Livré</p>', '<p>N/A</p>');
    expect(() => parseOzon(unknown, SAMPLE)).toThrow(expect.objectContaining({ kind: 'indeterminate', reason: 'listed' }));
  });

  it('refuses a card with an invalid date or a step without its status', () => {
    expect(() => parseOzon(DELIVERED.replace('28/06/2026 17:12</div>', '31/02/2026 17:12</div>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOzon(DELIVERED.replace('>Livré</div>', '></div>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseOzon(DELIVERED.replace(/<h3>Numéro du récépissé<\/h3>/, '<h3>Numéro</h3>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Ozon Express statuses', () => {
  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'ozon-express-ma', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
      expect(statusMap.stage(null, entry.wording)).toBe(entry.stage);
    }
  });
});

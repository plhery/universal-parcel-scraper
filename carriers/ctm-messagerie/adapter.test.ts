import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { statusMapAnswer } from '../../core/catalog/statusMaps.js';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter, CTM_LOOKUP } from './adapter.js';
import { normalizeCtmNumber, parseCtm } from './parser.js';
import { statusMap } from './status.js';
import statuses from './statuses.json' with { type: 'json' };

// The public sample in numbers.json, and an invented number the tracker does not know.
const SAMPLE = '2054302';
const OTHER = 'ZZ00000000QQ';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
const DELIVERED = fixture('delivered');
const NOT_FOUND = fixture('not-found');
const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { 'Content-Type': 'text/html; charset=UTF-8', ...init.headers } });
const carrier = (fetcher: typeof fetch) => adapter({ fetcher, recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null });

describe('CTM Messagerie numbers', () => {
  it('takes letters and digits with at least one digit, in capitals', () => {
    expect(normalizeCtmNumber(` ${SAMPLE} `)).toBe(SAMPLE);
    expect(normalizeCtmNumber('zz00000000qq')).toBe(OTHER);
    for (const other of ['', '1234', 'ABCDEFGHIJ', `${SAMPLE};${OTHER}`, '2054/302', '1'.repeat(21)]) {
      expect(() => normalizeCtmNumber(other), other).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });
});

describe('CTM Messagerie tracking adapter', () => {
  it('posts the number as the tracking page’s form does', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(html(DELIVERED));
    await expect(carrier(fetcher).track({ number: SAMPLE })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe(CTM_LOOKUP);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual', signal: expect.any(AbortSignal), body: `ndesuivi=${SAMPLE}` });
    expect(carrier(fetcher)).toMatchObject({ id: 'ctm-messagerie', recordsSteps: true, steps: ['direct', 'retry'] });
  });

  it('reads the page’s alert for an unknown number as not found', async () => {
    await expect(carrier(vi.fn<typeof fetch>().mockResolvedValue(html(NOT_FOUND))).track({ number: OTHER }))
      .rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps challenges, other refusals, redirects and changed pages apart from a missing parcel', async () => {
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
    expect(await answer(() => html('', { status: 302, headers: { Location: 'https://ctm-messagerie.ma/' } }))).toMatchObject({ kind: 'transport' });
    expect(await answer(() => html('Internal error', { status: 500 }))).not.toMatchObject({ kind: 'not_found' });
    expect(await answer(() => html('<html><body>Maintenance</body></html>'))).toMatchObject({ kind: 'schema' });
    // The result section without its alert is a changed page.
    expect(await answer(() => html(NOT_FOUND.replace(/<div class="alert[\s\S]*?<\/div>/, '')))).toMatchObject({ kind: 'schema' });
    // The alert inside a comment is not the page's answer.
    expect(await answer(() => html(NOT_FOUND.replace('<div class="alert', '<!--<div class="alert').replace('</p>', '</p>-->')))).toMatchObject({ kind: 'schema' });
  });
});

describe('CTM Messagerie replies', () => {
  it('reads the public sample: delivered, newest row first, on the wall clocks the page shows', () => {
    const result = parseCtm(DELIVERED, SAMPLE);
    expect(result).toEqual({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', last_status_text: 'Livré - Conforme',
      last_update: null, last_update_local: '2024-08-17T10:42:00', expected_delivery: null,
      events: [
        { local_time: '2024-08-17T10:42:00', description: 'Livré - Conforme', location: 'Marrakech', stage: 'delivered', stage_source: 'carrier_map' },
        { local_time: '2024-08-17T10:42:00', description: 'Expédié - Expédition conforme', location: 'Siège -centre de tri', stage: 'in_transit', stage_source: 'carrier_map' },
      ],
    });
    // The recipient's name is never read, and the commented-out sample rows are not history.
    expect(JSON.stringify(result)).not.toMatch(/RECIPIENT|2018|16h15/);
  });

  it('reads a result for another number as an open answer', () => {
    expect(() => parseCtm(DELIVERED, '2054303')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('refuses a result with an invalid date, a row without its status or no history', () => {
    expect(() => parseCtm(DELIVERED.replace('<p>17/08/2024 10:42</p>', '<p>32/08/2024 10:42</p>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCtm(DELIVERED.replace(/Livré - Conforme\s*<\/p>/, '</p>'), SAMPLE)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseCtm(DELIVERED.replace(/<div class="row row_[\s\S]*?(?=<\/div>\s*<\/div>\s*<\/section>|<!--)/, ''), SAMPLE))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('CTM Messagerie statuses', () => {
  it('maps every wording it lists', () => {
    for (const entry of statuses.entries) {
      expect(statusMapAnswer({ carrier: 'ctm-messagerie', providerCode: null, description: entry.wording })).toMatchObject({ stage: entry.stage });
      expect(statusMap.stage(null, entry.wording)).toBe(entry.stage);
    }
  });
});

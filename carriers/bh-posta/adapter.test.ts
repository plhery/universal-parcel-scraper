import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BhPostaTracker } from './adapter.js';
import { bhPostaFormFields, normalizeBhPostaNumber, parseBhPosta } from './parser.js';

const NUMBER = 'ZZ000000014BA', OTHER = 'ZZ000000028BA';
const fields = '<input type="hidden" name="__VIEWSTATE" value="synthetic+state/"><input type="hidden" name="__VIEWSTATEGENERATOR" value="ABCDEF12"><input type="hidden" name="__EVENTVALIDATION" value="synthetic-validation">';
const form = (number = '') => `<form id="form1" method="post" action="./">${fields}<input name="tbBrojPosiljke" value="${number}"><input type="submit" name="btnIzlistaj" value="Traži"></form>`;
const heading = `<tr><td colspan="5">Pregled događaja za pošiljku broj: ${NUMBER}</td></tr>`;
const row = (clock: string, text: string) => `<tr><td>${clock}</td><td>BOSNIA AND HERZEGOVINA</td><td>88420 - Jablanica</td><td>${text}</td><td>PRIVATE note / signer</td></tr>`;
const fixture = () => `${form(NUMBER)}<span id="Label1"><table>${heading}
<tr><th>Datum i vrijeme</th><th>Zemlja</th><th>Lokacija</th><th>Događaj</th><th>Napomena</th></tr>
${row('09.09.2026 15:21:20', 'Prijem pošiljke u pošti')}${row('11.09.2026 07:35:26', 'Na dostavi')}${row('11.09.2026 13:55:32', 'Pošiljka uručena')}</table></span>`;

describe('BH Pošta guest tracking', () => {
  it('parses the native table structure and all seven operational rows', () => {
    const html = readFileSync(new URL('./fixtures/delivered.html', import.meta.url), 'utf8');
    const result = parseBhPosta(html, NUMBER);
    expect(result.events).toHaveLength(7);
    expect(result.events![0]).toMatchObject({ local_time: '2026-09-11T13:55:32', stage: 'delivered' });
    expect(result.events![6]).toMatchObject({ local_time: '2026-09-09T15:21:20', stage: 'accepted' });
  });
  it('keeps whole postal identity and fresh state, scoped to the official form', () => {
    expect(normalizeBhPostaNumber(' zz 000000014 ba ')).toBe(NUMBER);
    const body = bhPostaFormFields(form(), NUMBER);
    expect(Object.fromEntries(body)).toEqual({ __VIEWSTATE: 'synthetic+state/', __VIEWSTATEGENERATOR: 'ABCDEF12', __EVENTVALIDATION: 'synthetic-validation', tbBrojPosiljke: NUMBER, btnIzlistaj: 'Traži' });
    expect(() => normalizeBhPostaNumber(NUMBER + 'EXTRA')).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    for (const html of [form().replace('./', 'https://other.invalid/'), form().replace('synthetic-validation', ''), form().replace(fields, fields + fields)]) {
      expect(() => bhPostaFormFields(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('reads observed stages and local scan clocks without notes or a blanket offset', () => {
    const result = parseBhPosta(fixture(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_update: null, last_update_local: '2026-09-11T13:55:32' });
    expect(result.events!.map(e => e.stage)).toEqual(['delivered', 'out_for_delivery', 'accepted']);
    expect(result.events!.every(e => e.local_time && !e.time)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('requires the whole number independently in both input and table heading', () => {
    for (const html of [fixture().replace(`value="${NUMBER}"`, `value="${OTHER}"`), fixture().replace(`broj: ${NUMBER}`, `broj: ${OTHER}`), fixture().replace(`broj: ${NUMBER}`, `broj: ${NUMBER}EXTRA`)]) {
      expect(() => parseBhPosta(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    }
  });

  it('does not turn empty history, changed HTML or verification into missing parcels', () => {
    expect(() => parseBhPosta(`${form(NUMBER)}<span id="Label1"><table>${heading}</table></span>`, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseBhPosta('<title>Just a moment</title>', NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    for (const html of [fixture().replace('11.09.2026 13:55:32', '31.02.2026 13:55:32'), fixture().replace('Događaj', 'Address'), fixture().replace('Pošiljka uručena', '')]) {
      expect(() => parseBhPosta(html, NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    }
  });

  it('uses the supplied transport, same-lookup cookie jar and exact native POST fields', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const response = new Response(init?.method === 'POST' ? fixture() : form(), { headers: { 'Set-Cookie': 'visitor=synthetic; Path=/; Secure' } });
      Object.defineProperty(response, 'url', { value: String(url) }); return response;
    });
    const tracker = new BhPostaTracker({ fetcher, userAgent: 'SyntheticHost/1.0' });
    await expect(tracker.fetch(NUMBER)).resolves.toHaveProperty('current_stage', 'delivered');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe('https://bhpwebout.posta.ba/trackwebapp/');
    const post = fetcher.mock.calls[1]![1]!;
    expect(post).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
    expect(new URLSearchParams(post.body as string).get('tbBrojPosiljke')).toBe(NUMBER);
    expect(new Headers(post.headers).get('cookie')).toBe('visitor=synthetic');
    expect(new Headers(post.headers).get('user-agent')).toBe('SyntheticHost/1.0');
    await expect(tracker.fetch(NUMBER, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(tracker.fetch('bad')).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it.each([[403, 'challenge'], [404, 'transport'], [429, 'rate_limited'], [500, 'indeterminate']] as const)('preserves HTTP %i as %s', async (status, kind) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(new BhPostaTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

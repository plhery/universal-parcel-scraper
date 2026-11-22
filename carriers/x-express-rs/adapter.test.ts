import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { carrierInfo } from '../../core/catalog/index.js';
import { detectCarrierMatch, parseTrackingInput } from '../../core/detection/index.js';
import { normalizeStatusWording } from '../../core/status/statusMap.js';
import { createTracker } from '../../facade/index.js';
import { XExpressRsTracker } from './adapter.js';
import { xExpressRsRequestNumber } from './number.js';
import { parseXExpressRs } from './parser.js';
import { statusMap } from './status.js';

const NUMBER = '26-0001234567';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const response = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('X Express Serbia guest adapter', () => {
  it('opens the share link for one shipment number, with no token or session', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    // Adapters receive the number without its hyphen; the tracker needs it back.
    const result = await new XExpressRsTracker({ fetcher, userAgent: 'SyntheticHost/1' }).fetch('260001234567', { budgetMs: 5000 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`https://www.x-express.rs/korisnicki-panel/pracenje-posiljke/${NUMBER}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'SyntheticHost/1' } });
    expect(new Headers(init!.headers).has('cookie')).toBe(false);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'PUDO - isporučena',
      last_update: null, last_update_local: '2026-09-24T16:34:00' });
  });

  it('keeps the scans newest first on Belgrade wall clocks and leaves the parties out', () => {
    const result = parseXExpressRs(page('delivered.html'), NUMBER);
    expect(result.events!.map(event => [event.local_time, event.description, event.stage])).toEqual([
      ['2026-09-24T16:34:00', 'PUDO - isporučena', 'delivered'],
      ['2026-09-24T14:02:00', 'PUDO - deponovana na isporuku', 'ready_for_pickup'],
      ['2026-09-22T14:09:00', 'Preuzeta od pošiljaoca', 'accepted'],
      ['2026-09-22T12:51:00', 'Usluga - Primalac preusmerio na PUDO', undefined],
      ['2026-09-21T07:41:00', 'Nalog kreiran', 'registered'],
    ]);
    expect(result.events!.every(event => !event.time && !event.location)).toBe(true);
    const text = JSON.stringify(result);
    for (const party of ['Ime...', 'Uli...', 'Grad', 'ČAROBNA']) expect(text).not.toContain(party);
  });

  it('reports a number the tracker does not know as not found, only for the number asked', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('not-found.html')));
    await expect(new XExpressRsTracker({ fetcher }).fetch('26-9999999999')).rejects.toMatchObject({ kind: 'not_found' });
    expect(() => parseXExpressRs(page('not-found.html'), '26-9999999998')).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // A result for another shipment is not this one.
    expect(() => parseXExpressRs(page('delivered.html'), '26-0001234568')).toThrowError(expect.objectContaining({ kind: 'schema' }));
  });

  it('checks the scans and the page', () => {
    const html = page('delivered.html');
    expect(() => parseXExpressRs(html.replace('24-09-26 14:02', '31-09-26 14:02'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXExpressRs(html.replace('24-09-26 14:02', '24-09-26'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseXExpressRs('<html><body>Održavanje</body></html>', NUMBER)).toThrowError(expect.objectContaining({ kind: 'schema' }));
    // A shipment with its status and no scans yet is a summary.
    const summary = parseXExpressRs(html.replace(/<div class="pracenje-track-box_v2[\s\S]*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/body>/, '</body>'), NUMBER);
    expect(summary).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'PUDO - isporučena', summary_only: true, events: [] });
    for (const number of ['0001234567', '26-000123456', '2600012345678', 'XX-0001234567', '123e4567-e89b-12d3-a456-426614174000']) {
      expect(() => xExpressRsRequestNumber(number), number).toThrowError(expect.objectContaining({ kind: 'invalid_input' }));
    }
    expect(xExpressRsRequestNumber(' 26 0001234567 ')).toBe(NUMBER);
  });

  it('keeps the browser check and transport failures distinct from a missing shipment', async () => {
    expect(() => parseXExpressRs(page('challenge.html'), NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    const captcha = '<html><body><div class="forma_neuspjesno">Došlo je do greške prilikom ReCaptcha validacije.</div></body></html>';
    expect(() => parseXExpressRs(captcha, NUMBER)).toThrowError(expect.objectContaining({ kind: 'challenge' }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('challenge.html')));
    await expect(new XExpressRsTracker({ fetcher }).fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    for (const [status, kind] of [[403, 'challenge'], [302, 'transport'], [404, 'transport'], [429, 'rate_limited']] as const) {
      const failing = vi.fn<typeof fetch>().mockResolvedValue(response('', status));
      await expect(new XExpressRsTracker({ fetcher: failing }).fetch(NUMBER)).rejects.toMatchObject({ kind });
      expect(failing).toHaveBeenCalledOnce();
    }
  });

  it('maps the wordings whole and leaves service requests without a stage on purpose', () => {
    expect(statusMap.stage(null, normalizeStatusWording('PUDO - deponovana na isporuku'))).toBe('ready_for_pickup');
    expect(statusMap.stage(null, normalizeStatusWording('PUDO - isporučena'))).toBe('delivered');
    expect(statusMap.stage(null, 'isporučena')).toBeUndefined();
    expect(statusMap.gapNote!(null, normalizeStatusWording('Usluga - Primalac preusmerio na PUDO'))).toBeDefined();
    expect(statusMap.gapNote!(null, normalizeStatusWording('Usluga - Promena datuma isporuke'))).toBeDefined();
    expect(statusMap.gapNote!(null, normalizeStatusWording('Pošiljka na putu'))).toBeUndefined();
    const result = parseXExpressRs(page('delivered.html').replaceAll('PUDO - isporučena', 'Vraćena pošiljaocu'), NUMBER);
    expect(result.events![0]!.stage).toBeUndefined();
    expect(result.status).toBe('unknown');
  });

  it('reads its share links, links with the hyphen and tracks on explicit selection', async () => {
    expect(detectCarrierMatch(NUMBER).candidates ?? []).not.toContain('x-express-rs');
    for (const link of [`https://www.x-express.rs/korisnicki-panel/pracenje-posiljke/${NUMBER}`, `https://x-express.rs/korisnicki-panel/pracenje-posiljke/${NUMBER}/`]) {
      expect(parseTrackingInput(link), link).toMatchObject({ trackingNumber: NUMBER, carrier: 'x-express-rs' });
    }
    expect(carrierInfo('x-express-rs').trackingUrl?.('260001234567')).toBe(`https://www.x-express.rs/korisnicki-panel/pracenje-posiljke/${NUMBER}`);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(page('delivered.html')));
    const tracked = await createTracker({ fetcher, env: {}, providers: [] }).track({ carrier: 'x-express-rs', number: NUMBER });
    expect(tracked.source).toBe('x-express-rs');
    expect(tracked.result.status).toBe('delivered');
    expect(fetcher.mock.calls[0]![0]).toBe(`https://www.x-express.rs/korisnicki-panel/pracenje-posiljke/${NUMBER}`);
  });
});

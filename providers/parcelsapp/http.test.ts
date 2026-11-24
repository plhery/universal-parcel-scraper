// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parcelsAppChecksum, parcelsAppPage, parcelsAppRequest, parcelsAppTicket, parcelsAppUserAgent, ParcelsAppHttpClient, PARCELSAPP_API } from './http.js';

describe('ParcelsApp public request protocol', () => {
  it.each([
    ['', 3354383590], ['a', 2293853823], ['ab', 323377070], ['abc', 3461430521],
    ['abcd', 2695833576], ['abcde', 1806874370],
  ] as const)('keeps the seed and partial-block checksum for %j', (text, hash) => {
    expect(parcelsAppChecksum(text)).toBe(hash);
  });

  it('form-encodes the shifted identifier twice and binds telemetry to the normalized number', () => {
    const form = new URLSearchParams(parcelsAppRequest('zz 123-456.78900').toString());
    const shifted = decodeURIComponent(form.get('trackingId')!);
    expect([...shifted].map((char) => String.fromCharCode((char.charCodeAt(0) - 76 + 126) % 126)).join('')).toBe('ZZ12345678900');
    expect(form.get('se')).toMatch(/,214,13,1378910874$/);
    const [outer, , inner] = form.get('se')!.split(',').map((size) => size.split('x').map(Number));
    expect(inner![0]).toBeLessThanOrEqual(outer![0]!);
    expect(inner![1]).toBeLessThanOrEqual(outer![1]!);
    expect(form.get('se')).not.toBe(parcelsAppRequest('ZZ12345678901').get('se'));
    expect([...form.keys()]).toEqual(['trackingId', 'carrier', 'language', 'country', 'platform', 'wd', 'c', 'p', 'l', 'se']);
    // The page's ticket travels as pt, with its version.
    const ticketed = parcelsAppRequest('ZZ12345678900', null, 'MS4xLjIuMw.abcdef0123456789');
    expect([ticketed.get('pt'), ticketed.get('ptv')]).toEqual(['MS4xLjIuMw.abcdef0123456789', '1']);
    expect(ticketed.get('se')).toBe(parcelsAppRequest('ZZ12345678900').get('se'));
  });

  it('reads the ticket the tracking page issues, and nothing else as one', () => {
    const page = (script: string) => `<html><head><script>\n  ${script}\n</script></head></html>`;
    expect(parcelsAppTicket(page('window.parcelsTicket = "MS4xNzAwMDAwMDAwLmFiY2QuMTAuMC4wLjA.0123456789abcdef0123456789abcdef";')))
      .toBe('MS4xNzAwMDAwMDAwLmFiY2QuMTAuMC4wLjA.0123456789abcdef0123456789abcdef');
    for (const script of ['window.parcelsTicket = "";', 'window.parcelsTicket = "<script>alert(1)</script>";', 'window.otherTicket = "MS4xNzAwMDAwMDAwLmFiY2Q.0123";']) {
      expect(parcelsAppTicket(page(script)), script).toBeUndefined();
    }
  });

  it('names the Chrome version stable releases have reached, since ParcelsApp refuses an outdated one', () => {
    const chrome = (date: number) => parcelsAppUserAgent(date).match(/Chrome\/(\d+)\.0\.0\.0 Safari\/537\.36$/)?.[1];
    expect(chrome(Date.UTC(2025, 9, 28))).toBe('142');
    expect(chrome(Date.UTC(2025, 10, 24))).toBe('142');
    expect(chrome(Date.UTC(2025, 10, 25))).toBe('143');
    // ParcelsApp refused Chrome 149 and earlier, and answered 150 and later, in November 2026.
    expect(Number(chrome(Date.UTC(2026, 10, 19)))).toBeGreaterThanOrEqual(150);
    expect(chrome(Date.UTC(2025, 0, 1))).toBe('142');
  });

  it('preserves leading zeros and alphanumeric postcodes, without allowing extra fields', () => {
    for (const postcode of ['01234', 'SW1A 1AA', '12-345', '01234&extra[email]=test']) {
      const form = new URLSearchParams(parcelsAppRequest('ZZ12345678900', ` ${postcode} `).toString());
      expect(form.get('extra[zipcode]')).toBe(postcode);
      expect(form.has('extra[email]')).toBe(false);
      expect(form.get('se')).toBe(parcelsAppRequest('ZZ12345678900').get('se'));
    }
    for (const postcode of [undefined, null, '', '  ']) expect(parcelsAppRequest('ZZ12345678900', postcode).has('extra[zipcode]')).toBe(false);
  });

  it('opens the tracking page for its ticket, then bounds the request and omits caching, redirects and cookies', async () => {
    const ticket = 'MS4xNzAwMDAwMDAwLmFiY2QuMTAuMC4wLjA.0123456789abcdef0123456789abcdef';
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(`<script>window.parcelsTicket = "${ticket}";</script>`, { headers: { 'Content-Type': 'text/html' } }))
      .mockResolvedValueOnce(Response.json({ states: [] }));
    await new ParcelsAppHttpClient(fetcher).fetch('ZZ12345678900', 1000.75, '01234');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([parcelsAppPage('ZZ12345678900'), PARCELSAPP_API]);
    expect(fetcher).toHaveBeenCalledWith(PARCELSAPP_API, expect.objectContaining({
      method: 'POST', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    const form = new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body));
    expect([form.get('pt'), form.get('ptv'), form.get('extra[zipcode]')]).toEqual([ticket, '1', '01234']);
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).get('User-Agent')).toBe(parcelsAppUserAgent());
    expect(new Headers(fetcher.mock.calls[0]![1]!.headers).has('cookie')).toBe(false);
    const headers = new Headers(fetcher.mock.calls[1]![1]!.headers);
    expect(headers.get('Content-Type')).toContain('application/x-www-form-urlencoded');
    expect(headers.get('User-Agent')).toMatch(/^Mozilla\/5\.0 \(Macintosh;.* Chrome\/\d/);
    expect(headers.get('User-Agent')).toBe(parcelsAppUserAgent());
    expect(headers.get('Accept-Language')).toBe('en-US,en;q=0.9');
    expect(headers.get('Accept')).toBe('application/json, text/javascript, */*; q=0.01');
    expect(headers.has('cookie')).toBe(false);
  });

  it('rejects invalid input before reaching the network', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = new ParcelsAppHttpClient(fetcher);
    await expect(http.fetch('https://localhost', 1000)).rejects.toThrow('Invalid tracking number');
    for (const timeout of [0, -1, NaN, Infinity]) await expect(http.fetch('ZZ12345678900', timeout)).rejects.toThrow('timeout must be positive');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects oversized and non-JSON responses', async () => {
    const page = () => new Response('<html>Tracking</html>');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response('', { headers: { 'Content-Length': '2000001' } }))
      .mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response('<html>Challenge</html>'));
    const http = new ParcelsAppHttpClient(fetcher);
    await expect(http.fetch('ZZ12345678900', 1000)).rejects.toThrow('unexpectedly large');
    await expect(http.fetch('ZZ12345678900', 1000)).rejects.toThrow('invalid tracking response');
    // Without a ticket on the page the API is still asked, and answers for itself.
    expect(new URLSearchParams(String(fetcher.mock.calls[1]![1]!.body)).has('pt')).toBe(false);
  });
});

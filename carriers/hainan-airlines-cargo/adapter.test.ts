import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectCarrierMatch } from '../../core/detection/index.js';
import { HAINAN_CARGO_CAPTCHA, HAINAN_CARGO_PAGE, HainanCargoTracker } from './adapter.js';
import { hainanCargoFormNumber, normalizeHainanCargoNumber, parseHainanCargo } from './parser.js';
import { statusMap } from './status.js';

// Made up: 880, then a serial whose last digit is the first seven's remainder by seven.
const NUMBER = '88012345675';
const page = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PICTURE = readFileSync(new URL('./fixtures/captcha-NZME.jpg', import.meta.url));

/** A tracker that hands out pictures and answers the form, accepting one code. */
function site(options: { page?: string; accepted?: string } = {}) {
  let session = 0;
  return vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url), headers = new Headers(init?.headers);
    expect(headers.get('cookie')).toContain('Language=zh-CN');
    if (target.startsWith(HAINAN_CARGO_CAPTCHA)) {
      session += 1;
      const response = new Response(PICTURE, { headers: { 'Content-Type': 'image/Jpeg', 'Set-Cookie': `ASP.NET_SessionId=synthetic${session}; path=/; HttpOnly` } });
      // The cookie jar files a cookie under the address that answered.
      Object.defineProperty(response, 'url', { value: target });
      return response;
    }
    if (target === HAINAN_CARGO_PAGE && init?.method === 'POST') {
      expect(headers.get('cookie')).toContain(`ASP.NET_SessionId=synthetic${session}`);
      const form = new URLSearchParams(String(init.body));
      expect(form.get('hdAwbCode')).toBe('880-12345675');
      if (form.get('hdVerifyCode') !== (options.accepted ?? 'NZME')) return new Response(page('refused.html'));
      return new Response(options.page ?? page('found.html'));
    }
    throw new Error(`unexpected request ${target}`);
  });
}

describe('Hainan Airlines Cargo air waybills', () => {
  it('takes the prefix and the serial, with or without the origin airport, and checks the serial', () => {
    expect(normalizeHainanCargoNumber('880-1234 5675')).toBe(NUMBER);
    expect(normalizeHainanCargoNumber('880-PEK-12345675')).toBe(NUMBER);
    expect(hainanCargoFormNumber(NUMBER)).toBe('880-12345675');
    for (const other of ['880-12345674', '810-12345675', '880-1234567', '880PE12345675']) {
      expect(() => normalizeHainanCargoNumber(other)).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    }
  });

  it('names Hainan Airlines Cargo for a dashed air waybill or one with its airport, not for eleven bare digits', () => {
    for (const written of ['880-12345675', '880-1234 5675', '880PEK12345675', '880-PEK-12345675']) {
      expect(detectCarrierMatch(written)).toMatchObject({ carrier: 'hainan-airlines-cargo', confidence: 'high' });
    }
    expect(detectCarrierMatch(NUMBER).candidates).not.toContain('hainan-airlines-cargo');
    expect(detectCarrierMatch('810-12345675').carrier).toBe('amerijet');
    expect(detectCarrierMatch('880PE12345675').candidates).not.toContain('hainan-airlines-cargo');
  });
});

describe('Hainan Airlines Cargo tracking page', () => {
  it('reads the scans of the air waybill the page names, on the station clock', () => {
    expect(parseHainanCargo(page('found.html'), '880-PEK-12345675')).toEqual({
      status: 'pending', current_stage: 'registered', current_stage_source: 'carrier_map',
      last_status_text: '已制单', last_update: null, last_update_local: '2026-05-12T09:41:07', expected_delivery: null,
      events: [{ local_time: '2026-05-12T09:41:07', location: 'HAK', description: '已制单', provider_code: '已制单', stage: 'registered', stage_source: 'carrier_map' }],
    });
  });

  it('puts the newest scan first and keeps an operation it has no record of without a mapped stage', () => {
    const found = page('found.html');
    const later = '<tr><td>PEK(北京首都)</td><td>2026-05-13 01:05</td><td>Departed</td><td>HU7XXX</td><td>6</td><td>118</td></tr>';
    const result = parseHainanCargo(found.replace(' </table></div>', ` ${later}</table></div>`), NUMBER);
    expect(result.events!.map((event) => [event.local_time, event.location, event.description, event.stage_source]))
      .toEqual([['2026-05-13T01:05:00', 'PEK', 'Departed', 'wording:language'], ['2026-05-12T09:41:07', 'HAK', '已制单', 'carrier_map']]);
    expect(statusMap.stage('已制单', '已制单')).toBe('registered');
    expect(statusMap.stage('Departed', 'Departed')).toBeUndefined();
  });

  it('tells an unknown air waybill, a refused code, another air waybill and a changed page apart', () => {
    expect(() => parseHainanCargo(page('not-found.html'), NUMBER)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHainanCargo(page('refused.html'), NUMBER)).toThrow(expect.objectContaining({ kind: 'challenge' }));
    expect(() => parseHainanCargo(page('found.html').replace('880-12345675</li>', '880-23456781</li>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseHainanCargo('<html><body>Service Unavailable</body></html>', NUMBER)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHainanCargo(page('found.html').replace('<td style="width: 96px;">操作</td>', '<td>Operation</td>'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHainanCargo(page('found.html').replace('2026-05-12 09:41:07', '2026-02-30 09:41:07'), NUMBER))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('Hainan Airlines Cargo tracker', () => {
  it('reads the verify code in the session its picture opens, and posts the air waybill with it', async () => {
    const fetcher = site();
    const tracker = new HainanCargoTracker({ fetcher, solveCaptcha: async () => 'NZME' });
    const result = await tracker.fetch('880-PEK-12345675');
    expect(result.events).toHaveLength(1);
    expect(fetcher.mock.calls.map(([url, init]) => [String(url), init?.method ?? 'GET'])).toEqual([
      [HAINAN_CARGO_CAPTCHA, 'GET'], [HAINAN_CARGO_PAGE, 'POST'],
    ]);
    await tracker.close();
  });

  it('takes a new picture after a refused code or an unreadable one, within three pictures', async () => {
    const answers = ['N2ME', 'ZZZZ', 'NZME'];
    const fetcher = site();
    const tracker = new HainanCargoTracker({ fetcher, solveCaptcha: async () => answers.shift()! });
    await expect(tracker.fetch(NUMBER)).resolves.toMatchObject({ current_stage: 'registered' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).startsWith(HAINAN_CARGO_CAPTCHA))).toHaveLength(3);
    const refusing = new HainanCargoTracker({ fetcher: site({ accepted: 'NONE' }), solveCaptcha: async () => 'ABCD' });
    await expect(refusing.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge', message: 'Hainan Airlines Cargo refused every verify code' });
    await Promise.all([tracker.close(), refusing.close()]);
  });

  it('reports an unknown air waybill as not found and a refused guest as a challenge', async () => {
    const unknown = new HainanCargoTracker({ fetcher: site({ page: page('not-found.html') }), solveCaptcha: async () => 'NZME' });
    await expect(unknown.fetch(NUMBER)).rejects.toMatchObject({ kind: 'not_found' });
    const blocked = new HainanCargoTracker({ fetcher: vi.fn<typeof fetch>(async () => new Response('Forbidden', { status: 403 })), solveCaptcha: async () => 'NZME' });
    await expect(blocked.fetch(NUMBER)).rejects.toMatchObject({ kind: 'challenge' });
    await Promise.all([unknown.close(), blocked.close()]);
  });
});

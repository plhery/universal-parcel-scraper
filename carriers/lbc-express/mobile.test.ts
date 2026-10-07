import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { adapter } from './adapter.js';
import { LBC_MOBILE_API, parseLbcMobile } from './mobile.js';

const NUMBER = '100000000001';
const xml = () => readFileSync(new URL('./fixtures/mobile.xml', import.meta.url), 'utf8');
const instance = (fetcher: typeof fetch, env = {}, browserExecutablePath: string | null = null) => adapter({
  fetcher, env, browserExecutablePath, trawl: null, recorder: NOOP_RECORDER, userAgent: 'Host/1.0',
});

describe('LBC mobile history', () => {
  it('binds identity, keeps newest-first local clocks and discards recipient and internal data', () => {
    const result = parseLbcMobile(xml(), NUMBER);
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: null, last_update_local: '2026-10-02T15:40:01' });
    expect(result.events).toHaveLength(3);
    expect(result.events?.map(event => event.stage)).toEqual(['delivered', 'out_for_delivery', 'accepted']);
    expect(result.events?.[0]).toMatchObject({ local_time: '2026-10-02T15:40:01', provider_code: '1' });
    expect(result.events?.every(event => !event.time)).toBe(true);
    expect(result.delivered_at).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SYNTHETIC RECIPIENT/);
  });
  it.each(['wrong identity', 'duplicate identity', 'missing identity', 'wrong namespace', 'malformed XML', 'DTD', 'nested text', 'bad clock'])('rejects %s without exposing raw XML', mode => {
    let body = xml();
    if (mode === 'wrong identity') body = body.replace(NUMBER, '100000000002');
    if (mode === 'duplicate identity') body = body.replace('</TrackingNo>', '</TrackingNo><TrackingNo>100000000001</TrackingNo>');
    if (mode === 'missing identity') body = body.replace(/<TrackingNo>.*?<\/TrackingNo>/, '');
    if (mode === 'wrong namespace') body = body.replace('http://tempuri.org/', 'https://other.example/');
    if (mode === 'malformed XML') body = body.replace('</TrackingStatus>', '</Other>');
    if (mode === 'DTD') body = body.replace('<soap:Envelope', '<!DOCTYPE soap:Envelope [<!ENTITY private "PRIVATE">]><soap:Envelope');
    if (mode === 'nested text') body = body.replace(NUMBER, `<Other>${NUMBER}</Other>`);
    if (mode === 'bad clock') body = body.replace('9:15:20 AM', '29:15:20 AM');
    let error: unknown;
    try { parseLbcMobile(body, NUMBER); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind: 'schema' });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain('PRIVATE');
  });
  it('deduplicates scans and keeps absent times date-only', () => {
    const body = xml().replace(/<DatePostedTime>.*?<\/DatePostedTime>/g, '');
    const result = parseLbcMobile(body, NUMBER);
    expect(result.events?.every(event => !event.local_time && !event.time)).toBe(true);
    expect(result.last_update_local).toBeUndefined();
    const row = /<TrackingHistory>\s*<StatusId>1<\/StatusId>[\s\S]*?<\/TrackingHistory>/.exec(xml())![0];
    expect(parseLbcMobile(xml().replace(row, row + row), NUMBER).events).toHaveLength(3);
  });
  it('leaves unknown codes unresolved and redacts delivery names', () => {
    const result = parseLbcMobile(xml().replace('<StatusId>1</StatusId>', '<StatusId>99999</StatusId>'), NUMBER);
    expect(result).toMatchObject({ status: 'unknown', last_status_text: 'Delivery update' });
    expect(result.current_stage).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it.each(['remittance', 'empty history', 'SOAP fault'])('keeps %s inconclusive', mode => {
    let body = xml();
    if (mode === 'remittance') body = body.replace('<StatusCode>0001</StatusCode>', '<StatusCode>103</StatusCode>');
    if (mode === 'empty history') body = body.replace(/<TrackingHistory>[\s\S]*<\/TrackingHistory>/, '<TrackingHistory/>');
    if (mode === 'SOAP fault') body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>PRIVATE</faultstring></s:Fault></s:Body></s:Envelope>';
    expect(() => parseLbcMobile(body, NUMBER)).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });
});

describe('LBC direct transport', () => {
  it('uses the built-in key without a browser and honors the supplied fetch, signal, budget and user agent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(xml()));
    const launch = vi.spyOn(chromium, 'launch');
    try {
      const result = await instance(fetcher).track({ number: NUMBER }, { budgetMs: 5000 });
      expect(result.current_stage).toBe('delivered');
      const [url, init] = fetcher.mock.calls[0]!;
      expect(url).toBe(LBC_MOBILE_API);
      expect(init).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal), cache: 'no-store', redirect: 'error' });
      expect(new Headers(init?.headers).get('lbcOAKey')).toMatch(/^[a-f\d]{32}$/i);
      expect(new Headers(init?.headers).get('user-agent')).toBe('Host/1.0');
      expect(new Headers(init?.headers).get('soapaction')).toBe('http://tempuri.org/LBCTrackAndTrace');
      expect(init?.body).toContain(`<TrackingNo>${NUMBER}</TrackingNo>`);
      expect(launch).not.toHaveBeenCalled();
    } finally { launch.mockRestore(); }
  });
  it('supports an environment key override', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(xml()));
    await instance(fetcher, { LBC_TRACKING_KEY: 'SYNTHETIC_TRACKING_KEY' }).track({ number: NUMBER });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('lbcOAKey')).toBe('SYNTHETIC_TRACKING_KEY');
  });
  it.each([401, 403, 404, 410, 429, 503])('keeps HTTP %s distinct from shipment absence', async status => {
    const fetcher: typeof fetch = async () => new Response('', { status });
    await expect(instance(fetcher).track({ number: NUMBER })).rejects.toMatchObject({ kind:
      [401, 403].includes(status) ? 'challenge' : [404, 410].includes(status) ? 'transport' : status === 429 ? 'rate_limited' : 'maintenance',
    });
  });
  it('recognizes blocked HTML 200 and bounds excessive replies', async () => {
    await expect(instance(async () => new Response('<html>Cloudflare challenge</html>')).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(instance(async () => new Response('x'.repeat(1_000_001))).track({ number: NUMBER })).rejects.toMatchObject({ kind: 'indeterminate' });
  });
  it.each(['network', 'rate limit', 'body read'])('sanitizes %s failure data while retaining its classification', async mode => {
    const key = 'SYNTHETIC_TRACKING_KEY';
    const privateData = `PRIVATE RECIPIENT ${NUMBER} ${key}`;
    const fetcher: typeof fetch = async () => {
      if (mode === 'network') throw new Error(privateData);
      if (mode === 'rate limit') return new Response(privateData, { status: 429, headers: { 'Retry-After': '60' } });
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateData)); } }));
    };
    const error: unknown = await instance(fetcher, { LBC_TRACKING_KEY: key }).track({ number: NUMBER }).catch(caught => caught);
    expect(error).toMatchObject({ kind: mode === 'rate limit' ? 'rate_limited' : 'transport',
      ...(mode === 'rate limit' ? { status: 429, retryAfterMs: 60_000 } : {}),
    });
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('diagnostics');
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|SYNTHETIC_TRACKING_KEY|100000000001/);
  });
  it('starts no request for invalid or pre-aborted input', async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => instance(fetcher).track({ number: 'bad' })).toThrow(expect.objectContaining({ kind: 'invalid_input' }));
    await expect(instance(fetcher).track({ number: NUMBER }, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

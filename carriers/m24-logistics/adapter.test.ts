import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOOP_RECORDER } from '../../core/telemetry/index.js';
import { discoverActionId } from './action.js';
import { adapter, M24_ACTION } from './adapter.js';
import { parseM24, readActionReply } from './parser.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const bytes = (text: string) => new TextEncoder().encode(text);
const reply = (name: string) => readActionReply(bytes(fixture(name)), 'text/x-component');
const component = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/x-component' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

// The shape of the order page's chunks: the route's own calls `vh` from module 24656 with the
// reference in its path, and that module builds `vh` from an id through module 12119's wrapper.
const NEW_ACTION = 'a'.repeat(40);
const ROUTE = '/_next/static/chunks/app/(end-customer)/track-my-order/%5Bslug%5D/page-518ec8481d236a8b.js';
const PAGE = `<html><head><script src="/_next/static/chunks/webpack-a6736df48d110c82.js" async=""></script>
<script src="/_next/static/chunks/8dc5345f-4a3f13b867e7a868.js" async=""></script>
<script src="/_next/static/chunks/666-ef1ca44c1bcc5ee4.js" async=""></script>
<script src="${ROUTE}" async=""></script>
<script src="/_next/static/chunks/280-55f92039c8a9e025.js" async=""></script></head><body></body></html>`;
const CHUNKS: Record<string, string> = {
  [ROUTE]: '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[9265],{43714:function(e,l,a){var Z=a(24656);'
    + 'function et(e){let{params:y}=e,_=y.slug;(async()=>{ep(!0);try{let l=await (0,Z.vh)(_);if(!l||0===l.length){M(!1);return}'
    + 'eo(l)}catch(e){console.error("Fetch error:",e)}})();(async()=>{let c=await (0,Z.b9)({PrimaryCustomer_ID:d.PrimaryCustomer})})()}}}]);',
  '/_next/static/chunks/280-55f92039c8a9e025.js': '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[280],{24656:function(e,t,n){'
    + 'n.d(t,{b9:function(){return S},vh:function(){return C}}),n(83079);var a=n(12119),'
    + `S=(0,a.$)("d6b82ed79e3df4bf84b7e8f32497b0ed1ae169d9"),C=(0,a.$)("${NEW_ACTION}")},55468:function(e,t,n){n(83079)}}]);`,
  '/_next/static/chunks/666-ef1ca44c1bcc5ee4.js': '(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[666],{12119:function(e,t,n){'
    + 'Object.defineProperty(t,"$",{enumerable:!0,get:function(){return o}});let r=n(83079);'
    + 'function o(e){let{createServerReference:t}=n(6671);return t(e,r.callServer)}},18848:function(e,t,n){}}]);',
};

function tracker(answer: (request: { url: string; method: string; action: string | null; body: string }) => Response) {
  const requests: { url: string; method: string; action: string | null; body: string }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    const request = { url: String(url), method: init.method ?? 'GET', action: new Headers(init.headers).get('next-action'), body: String(init.body ?? '') };
    requests.push(request);
    return answer(request);
  }) as typeof fetch;
  return { requests, track: adapter({ recorder: NOOP_RECORDER, env: {}, trawl: null, browserExecutablePath: null, fetcher }) };
}

describe('M24 Logistics tracking', () => {
  it('reads a delivered order with its failed rounds, on South African clocks', () => {
    const result = parseM24(reply('delivered-courier-it.txt'), 'O2001531786');
    expect(result).toMatchObject({
      status: 'delivered', current_stage: 'delivered', current_stage_source: 'carrier_map', provider_code: '9',
      last_status_text: 'Delivered', last_update: '2026-05-12T18:09:41+02:00', delivered_at: '2026-05-12T18:09:41+02:00',
      signed_by: 'removed', service_name: 'ECONOMY',
    });
    expect(result.events).toHaveLength(20);
    expect(result.events!.at(-1)).toMatchObject({
      time: '2026-04-30T10:45:00+02:00', local_time: '2026-04-30T10:45:00', time_zone: 'Africa/Johannesburg', time_zone_basis: 'carrier',
      description: 'Inserted', provider_code: '1', stage: 'registered', stage_source: 'carrier_map',
    });
    expect(result.events!.find((event) => event.provider_code === '133')).toMatchObject({
      time: '2026-05-07T15:22:16+02:00', description: 'Vehicle Breakdown.', stage: 'failed_attempt',
    });
    expect(result.events!.filter((event) => event.provider_code === '54')).toHaveLength(6);
    const times = result.events!.map((event) => Date.parse(event.time!));
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });

  it('keeps M24\'s order for scans written at the same minute', () => {
    const result = parseM24(reply('delivered-dpd.txt'), 'O1983692063');
    expect(result).toMatchObject({ current_stage: 'delivered', service_name: 'Overnight', delivered_at: '2026-04-08T13:13:47+02:00' });
    expect(result.events!.slice(-4).map((event) => event.provider_code)).toEqual(['7', '3', '2', '1']);
  });

  it('answers to the order\'s other references, and rejects a reply for another order', () => {
    for (const reference of ['ESP1T94494275', 'ESP1S94494275', '20361435', 'ONL01SG2368714119']) {
      expect(parseM24(reply('delivered-courier-it.txt'), reference)).toMatchObject({ current_stage: 'delivered' });
    }
    expect(() => parseM24(reply('delivered-courier-it.txt'), 'O1983692063')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
  });

  it('reads only an empty order list as not found', () => {
    const empty = readActionReply(bytes('0:["$@1",["0.1.132",null]]\n1:[]\n'), 'text/x-component');
    expect(() => parseM24(empty, 'O1000000001')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    const message = readActionReply(bytes('0:["$@1",["0.1.132",null]]\n1:{"ResponseCode":"500","ResponseMessage":"Something went wrong"}\n'), 'text/x-component');
    expect(() => parseM24(message, 'O1000000001')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    expect(() => parseM24(null, 'O1000000001')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('never reads a blocked, failed or malformed reply as not found', () => {
    const check = bytes('<html><head><title>Just a moment...</title></head><body>cf-turnstile</body></html>');
    expect(() => readActionReply(check, 'text/html')).toThrow(expect.objectContaining({ kind: 'challenge' }));
    // The order page itself, which Next renders for an action it does not have.
    expect(() => readActionReply(bytes('<!DOCTYPE html><html></html>'), 'text/html')).toThrow(expect.objectContaining({ name: 'UnknownActionError', kind: 'schema' }));
    expect(() => readActionReply(bytes('Maintenance'), 'text/plain')).toThrow(expect.objectContaining({ kind: 'schema' }));
    const thrown = bytes('0:["$@1",["0.1.132",null]]\n1:E{"digest":"2210430151"}\n');
    expect(() => readActionReply(thrown, 'text/x-component')).toThrow(expect.objectContaining({ kind: 'indeterminate' }));
    const clockless = fixture('delivered-dpd.txt').replace('"StatusDate":"2026-04-08T13:13:47"', '"StatusDate":"08/04/2026"');
    expect(() => parseM24(readActionReply(bytes(clockless), 'text/x-component'), 'O1983692063')).toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('calls the order page\'s action and keeps HTTP failures apart from not found', async () => {
    const found = tracker(() => component(fixture('delivered-courier-it.txt')));
    await expect(found.track.track({ number: ' o2001531786 ' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(found.requests).toEqual([{ url: 'https://lms.m24logistics.com/track-my-order/O2001531786', method: 'POST', action: M24_ACTION, body: '["O2001531786"]' }]);

    // The tracker fails an unknown reference with the same bare server error as any other failure.
    const unknown = tracker(() => html(fixture('unknown-reference.html'), 500));
    await expect(unknown.track.track({ number: 'O1000000001' })).rejects.toMatchObject({ kind: 'indeterminate', status: 500 });
    const limited = tracker(() => new Response('Too many requests', { status: 429 }));
    await expect(limited.track.track({ number: 'O2001531786' })).rejects.toMatchObject({ kind: 'rate_limited' });
    const blocked = tracker(() => html('<html><head><title>Attention Required! | Cloudflare</title></head></html>', 403));
    await expect(blocked.track.track({ number: 'O2001531786' })).rejects.toMatchObject({ kind: 'challenge' });
    const challenged = tracker(() => html('<html><head><title>Just a moment...</title></head><body>_cf_chl_opt</body></html>'));
    await expect(challenged.track.track({ number: 'O2001531786' })).rejects.toMatchObject({ kind: 'challenge' });
    await expect(found.track.track({ number: 'O1' })).rejects.toMatchObject({ kind: 'invalid_input' });
  });

  it('reads the current action from the page when the tracker no longer knows its own', async () => {
    const stale = tracker(({ url, method, action }) => {
      const path = new URL(url).pathname;
      if (method === 'POST') return action === NEW_ACTION ? component(fixture('delivered-dpd.txt')) : html('<!DOCTYPE html><html><body>Track my order</body></html>');
      if (path === '/track-my-order/O1983692063') return html(PAGE);
      const chunk = CHUNKS[path];
      return chunk === undefined ? new Response('', { status: 200 }) : new Response(chunk, { status: 200 });
    });
    await expect(stale.track.track({ number: 'O1983692063' })).resolves.toMatchObject({ current_stage: 'delivered' });
    const posts = stale.requests.filter((request) => request.method === 'POST').map((request) => request.action);
    expect(posts).toEqual([M24_ACTION, NEW_ACTION]);
    // The vendor bundle is never read.
    expect(stale.requests.some((request) => request.url.includes('8dc5345f'))).toBe(false);

    // The id stays the first try for the lookups after it.
    await expect(stale.track.track({ number: 'O1983692063' })).resolves.toMatchObject({ current_stage: 'delivered' });
    expect(stale.requests.filter((request) => request.method === 'POST').at(-1)!.action).toBe(NEW_ACTION);
  });

  it('finds the lookup\'s id only where the page\'s chunks build it from one', async () => {
    const read = async (url: string) => CHUNKS[new URL(url).pathname] ?? '';
    const page = 'https://lms.m24logistics.com/track-my-order/O1983692063';
    await expect(discoverActionId(PAGE, page, read)).resolves.toBe(NEW_ACTION);
    const unwrapped = async (url: string) => (new URL(url).pathname.startsWith('/_next/static/chunks/666-') ? '' : read(url));
    await expect(discoverActionId(PAGE, page, unwrapped)).resolves.toBeUndefined();
    await expect(discoverActionId(PAGE.replace(ROUTE, '/_next/static/chunks/app/layout-1.js'), page, read)).resolves.toBeUndefined();
  });
});

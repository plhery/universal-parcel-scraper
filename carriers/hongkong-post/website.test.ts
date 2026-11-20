// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { normalizeCarrierResult } from '../../core/result/index.js';
import { resolveResult } from '../../core/result/resolve.js';
import { HongkongPostTracker } from './adapter.js';
import { HONGKONG_POST_POLL, HONGKONG_POST_SEND } from './chatbot.js';
import { parseHongkongPostHistory } from './history.js';
import { HONGKONG_POST_TRACKING } from './website.js';

const PUBLIC = 'LP157079155HK';
const UNKNOWN = 'RR123456785HK';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const delivered = fixture('website-delivered');
const notFound = fixture('website-not-found');
const replies = JSON.parse(readFileSync(new URL('./fixtures/replies.json', import.meta.url), 'utf8'));
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json' } });
const item = (changes: Record<string, unknown>, number = PUBLIC) => ({ ...delivered, items: { [number]: { ...delivered.items[PUBLIC], ...changes } } });

describe('Hongkong Post tracker history', () => {
  it('reads every scan newest first on the clock of its place', () => {
    const result = normalizeCarrierResult(parseHongkongPostHistory(delivered, PUBLIC));
    expect(result).toMatchObject({ status: 'delivered', current_stage: 'delivered', last_status_text: 'Delivered',
      last_update: '2026-06-25T10:27:00+09:00', last_update_local: '2026-06-25T10:27:00', service_name: 'Outward e-Express',
      destination_country: 'JP' });
    expect(result.summary_only).toBeUndefined();
    expect(result.events).toHaveLength(8);
    expect(result.events![0]).toEqual({ local_time: '2026-06-25T10:27:00', time: '2026-06-25T10:27:00+09:00', time_zone: 'Asia/Tokyo',
      time_zone_basis: 'place', location: 'JAPAN', description: 'Delivered', stage: 'delivered', stage_source: 'carrier_map' });
    expect(result.events!.at(-1)).toMatchObject({ local_time: '2026-06-13T09:18:00', time: '2026-06-13T09:18:00+08:00',
      time_zone: 'Asia/Hong_Kong', location: 'HONG KONG', description: 'Sender is preparing item for posting', stage: 'registered' });
    expect(result.events!.map((event) => event.stage)).toEqual(['delivered', 'failed_attempt', 'in_transit', 'customs', 'in_transit',
      'in_transit', 'accepted', 'registered']);
    expect(resolveResult(result)).toMatchObject({ current_stage: 'delivered' });
  });

  it('keeps the wall clock alone where the country keeps several zones', () => {
    const abroad = item({ event: [{ date: '02-07-2026 08:05', location_name: 'UNITED STATES', message: 'Synthetic new wording', location: '' }] });
    expect(parseHongkongPostHistory(abroad, PUBLIC)).toMatchObject({ status: 'unknown', last_update: null, last_update_local: '2026-07-02T08:05:00',
      events: [{ local_time: '2026-07-02T08:05:00', location: 'UNITED STATES', description: 'Synthetic new wording' }] });
    expect(parseHongkongPostHistory(abroad, PUBLIC).events![0]).not.toHaveProperty('time');
  });

  it('answers not found only for the item the reply names', () => {
    expect(() => parseHongkongPostHistory(notFound, UNKNOWN)).toThrow(expect.objectContaining({ kind: 'not_found' }));
    expect(() => parseHongkongPostHistory(notFound, PUBLIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHongkongPostHistory(item({ itemNo: UNKNOWN }), PUBLIC)).toThrow(expect.objectContaining({ kind: 'schema' }));
    expect(() => parseHongkongPostHistory({ ...delivered, items: { ...delivered.items, [UNKNOWN]: notFound.items[UNKNOWN] } }, PUBLIC))
      .toThrow(expect.objectContaining({ kind: 'schema' }));
  });

  it('keeps refusals, failures and unknown answers apart from a missing parcel', () => {
    for (const [reply, kind] of [
      [{ ...notFound, check_auth: false }, 'challenge'], [{ ...notFound, captcha_null: true }, 'challenge'],
      [{ ...notFound, catchWebException: true }, 'indeterminate'], [item({ result: '1' }), 'indeterminate'],
      [item({ detail_flag: false }), 'indeterminate'], [item({ event: [] }), 'indeterminate'],
      [item({ event: [{ date: '2026-06-25 10:27', location_name: 'JAPAN', message: 'Delivered' }] }), 'schema'],
      [item({ event: [{ date: '31-02-2026 10:27', location_name: 'JAPAN', message: 'Delivered' }] }), 'schema'],
      [item({ event: [{ date: '25-06-2026 10:27', location_name: 'JAPAN', message: '' }] }), 'schema'],
      [[], 'schema'],
    ] as const) {
      expect(() => parseHongkongPostHistory(reply, reply === notFound ? UNKNOWN : PUBLIC), JSON.stringify(reply).slice(0, 80))
        .toThrow(expect.objectContaining({ kind }));
    }
  });
});

/** MTCaptcha passing at once, the tracker answering `tracked`, and a chatbot answering its found reply. */
function site(tracked: () => Response, options: { wait?: string } = {}) {
  let chatbot: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes('/getchallenge.json')) {
      return json({ code: 1200, result: { challenge: { ct: 'c1(6.synthetic-challenge)', hasTextChlg: true, textChlg: { textlen: 5 }, hasFoldChlg: true,
        foldChlg: { fseed: 'oVUluRcXxY4YwV3pa78chuk7hI-BnLn_leHg_zTt_mDaVFwazkYoJvgnUiz5WE5R', fslots: 3, fdepth: 50, preRes: true },
        hasWaitChlg: options.wait !== undefined, waitChlg: { time: options.wait } } } });
    }
    if (url.includes('/getimage.json')) return json({ code: 1200, result: { img: { image64: 'R0lGODlh' } } });
    if (url.includes('/solvechallenge.json')) return json({ code: 1200, result: { verifyResult: { isVerified: true, verifiedToken: { vt: 'v1(synthetic-token)', vtttl: 60 } } } });
    if (url === HONGKONG_POST_TRACKING) return tracked();
    const body = JSON.parse(String(init?.body));
    if (url === HONGKONG_POST_SEND) {
      chatbot = { init: ['language'], 2: ['main'], 3: ['tracing'], 1: ['prompt'] }[body.input.content as string] ?? ['found'];
      return json(replies.ack);
    }
    if (url === HONGKONG_POST_POLL) { const next = chatbot.shift(); return next ? json(replies[next]) : json(replies.timeout, { status: 408 }); }
    throw new Error(`Unexpected request to ${url}`);
  });
  const tracker = new HongkongPostTracker({ fetcher, userAgent: 'SyntheticHost/1.0', solveCaptcha: async () => 'aB3dE' });
  const urls = () => fetcher.mock.calls.map(([input]) => String(input));
  return { fetcher, tracker, urls };
}

describe('Hongkong Post tracker step', () => {
  it('sends the number once with its token, as the page does', async () => {
    const { fetcher, tracker, urls } = site(() => json(delivered));
    await expect(tracker.fetch(` ${PUBLIC.toLowerCase()} `)).resolves.toMatchObject({ status: 'delivered', events: expect.arrayContaining([]) });
    expect(urls().some((url) => url.includes(PUBLIC))).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => String(init?.body ?? '').includes(PUBLIC)).map(([input]) => String(input))).toEqual([HONGKONG_POST_TRACKING]);
    expect(urls().some((url) => url.startsWith('https://chatbot.'))).toBe(false);
    const [, init] = fetcher.mock.calls.find(([input]) => String(input) === HONGKONG_POST_TRACKING)!;
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body)).toEqual(['b', 'itemNo', 'lang', 'path', 'mtCaptchaToken']);
    expect(body).toEqual({ b: expect.stringMatching(/^[A-Za-z0-9]{8}$/), itemNo: PUBLIC, lang: 'E', path: '2', mtCaptchaToken: 'v1(synthetic-token)' });
    expect(init!.method).toBe('POST');
    const headers = new Headers(init!.headers);
    expect(headers.get('user-agent')).toBe('SyntheticHost/1.0');
    expect(headers.get('origin')).toBe('https://webapp.hongkongpost.hk');
    await tracker.close();
  });

  it('ends at the tracker\'s not-found, without asking the chatbot', async () => {
    const { tracker, urls } = site(() => json(notFound));
    await expect(tracker.fetch(UNKNOWN)).rejects.toMatchObject({ kind: 'not_found' });
    expect(urls().some((url) => url.startsWith('https://chatbot.'))).toBe(false);
  });

  it('falls back to the chatbot\'s latest status when the tracker refuses, fails or runs out of its share', async () => {
    for (const tracked of [() => json({ ...delivered, check_auth: false }), () => json({}, { status: 500 }),
      () => new Response('<html>blocked</html>', { headers: { 'Content-Type': 'text/html' } })]) {
      const { tracker, urls } = site(tracked);
      await expect(tracker.fetch(PUBLIC)).resolves.toMatchObject({ status: 'delivered', summary_only: true, events: [] });
      expect(urls().filter((url) => url === HONGKONG_POST_SEND)).toHaveLength(5);
    }
    // A 25.5 s wait does not fit the tracker's share of a 20 s budget.
    const { tracker, urls } = site(() => json(delivered), { wait: '04c' });
    await expect(tracker.fetch(PUBLIC, { budgetMs: 20_000 })).resolves.toMatchObject({ summary_only: true });
    expect(urls().includes(HONGKONG_POST_TRACKING)).toBe(false);
  });

  it('leaves a short budget to the chatbot alone', async () => {
    const { tracker, urls } = site(() => json(delivered));
    await expect(tracker.fetch(PUBLIC, { budgetMs: 10_000 })).resolves.toMatchObject({ summary_only: true });
    expect(urls().every((url) => url.startsWith('https://chatbot.'))).toBe(true);
  });
});

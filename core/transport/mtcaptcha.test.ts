// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mtcaptchaFold, mtcaptchaKeystrokes, mtcaptchaToken, mtcaptchaWaitMs, type MtcaptchaSite } from './mtcaptcha.js';

const SEED = 'oVUluRcXxY4YwV3pa78chuk7hI-BnLn_leHg_zTt_mDaVFwazkYoJvgnUiz5WE5R';
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const SITE: MtcaptchaSite = { provider: 'Synthetic Post', sitekey: 'MTPublic-l0oMcZgZB', domain: 'tracking.example', action: 'synthetic' };
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json' } });

interface Script { textlen?: number; preRes?: boolean; wait?: string; verified?: boolean }

/** MTCaptcha's API, one challenge per script entry; the picture's bytes name the challenge. */
function service(script: Script[]) {
  let opened = 0;
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    const step = script[Number(/-(\d+)\)$/.exec(url.searchParams.get('ct') ?? '')?.[1] ?? opened)]!;
    if (url.pathname.endsWith('/getchallenge.json')) {
      const index = opened++;
      const entry = script[index]!;
      return json({ code: 1200, result: { challenge: { ct: `c1(6.synthetic-challenge-${index})`, ctttl: 900,
        hasTextChlg: entry.textlen !== undefined, ...(entry.textlen === undefined ? {} : { textChlg: { textlen: entry.textlen } }),
        hasFoldChlg: true, foldChlg: { fseed: SEED, fslots: 3, fdepth: 50, preRes: entry.preRes ?? true },
        hasWaitChlg: entry.wait !== undefined, ...(entry.wait === undefined ? {} : { waitChlg: { time: entry.wait } }) } } });
    }
    if (url.pathname.endsWith('/getimage.json')) {
      return json({ code: 1200, result: { img: { image64: Buffer.from(url.searchParams.get('ct')!).toString('base64') } } });
    }
    if (url.pathname.endsWith('/solvechallenge.json')) {
      return json({ code: 1200, result: { verifyResult: step.verified
        ? { isVerified: true, verifiedToken: { vt: 'v1(synthetic-token)', vtttl: 60 } } : { isVerified: false, verifiedToken: { vt: '', vtttl: -1 } } } });
    }
    throw new Error(`Unexpected request to ${url.href}`);
  });
  const calls = () => fetcher.mock.calls.map(([input]) => new URL(String(input)));
  return { fetcher, calls };
}

const lookup = (fetcher: typeof fetch, solve: (image: Uint8Array) => string, options: { deadlineMs?: number; pictures?: number } = {}) => ({
  fetcher, userAgent: 'SyntheticHost/1.0', signal: AbortSignal.timeout(10_000), deadline: performance.now() + (options.deadlineMs ?? 10_000),
  budgetMs: options.deadlineMs ?? 10_000, solve: async (image: Uint8Array) => solve(image), ...(options.pictures ? { pictures: options.pictures } : {}),
});

describe('MTCaptcha widget proofs', () => {
  it('folds the seed as the widget does', () => {
    expect(mtcaptchaFold(SEED, 3, 50)).toBe('YfvOf2');
    expect(mtcaptchaFold(SEED, 40, 21328)).toBe('ACG5sSPkrg1vApCiWjzwpWikFIbbAUs8g-pREVt8k1n-Rd57zIdvbqtTWoGGHw5Djmnd8T7o1yRNpOBv');
  });

  it('reads the wait clue in tenths of a second', () => {
    expect(mtcaptchaWaitMs('0a4')).toBe(3900);
    expect(mtcaptchaWaitMs('227')).toBe(5200);
    expect(mtcaptchaWaitMs('04c')).toBe(25_500);
  });

  it('records the typing the answer spells, keyed by the seed', () => {
    const untouched = mtcaptchaKeystrokes(SEED, '', []);
    expect(untouched).toMatch(/^[0-9A-Za-z_-]{64}$/);
    const typed = mtcaptchaKeystrokes(SEED, 'aB3', [7, 9]);
    const key = [...untouched].map((character) => DIGITS.indexOf(character));
    const record = [...typed].map((character, index) => DIGITS.indexOf(character) ^ key[index]!);
    // Each key at its turn, the tenths since the one before, and the end mark after the last.
    expect(record.slice(0, 9)).toEqual([0, 6, DIGITS.indexOf('a'), 0, DIGITS.indexOf('B'), 7, DIGITS.indexOf('3'), 9, 63]);
    expect(record.slice(9).every((value) => value === 0)).toBe(true);
  });
});

describe('MTCaptcha token', () => {
  it('skips a misread length, answers the next picture after its wait, and returns the token', async () => {
    const { fetcher, calls } = service([{ textlen: 5 }, { textlen: 5, preRes: false, wait: '0ea', verified: true }]);
    const reads: string[] = [];
    const started = performance.now();
    const token = await mtcaptchaToken(SITE, lookup(fetcher, (image) => {
      reads.push(Buffer.from(image).toString());
      return reads.length === 1 ? 'ab1d' : 'aB-3 dE';
    }));
    expect(token).toBe('v1(synthetic-token)');
    expect(reads).toEqual(['c1(6.synthetic-challenge-0)', 'c1(6.synthetic-challenge-1)']);
    expect(calls().map((url) => url.pathname.split('/').pop())).toEqual(['getchallenge.json', 'getimage.json', 'getchallenge.json', 'getimage.json', 'solvechallenge.json']);
    const [first, image, , lateImage, answer] = calls();
    expect(Object.fromEntries(first!.searchParams)).toMatchObject({ sk: SITE.sitekey, bd: 'tracking.example', act: 'synthetic',
      tsh: 'TH[879d08a9174aba9ec6cf689c75001f5c]', lf: '1', tl: '$', lg: 'en', tp: 's' });
    expect(first!.searchParams.get('ss')).toMatch(/^S1[0-9a-f-]{36}$/);
    // The proof goes with the picture request only when the challenge asks for it early.
    expect(image!.searchParams.get('fa')).toBe('YfvOf2');
    expect(lateImage!.searchParams.get('fa')).toBe('$');
    expect(Object.fromEntries(answer!.searchParams)).toMatchObject({ ct: 'c1(6.synthetic-challenge-1)', st: 'aB3dE', fa: 'YfvOf2', fs: SEED, qh: '$' });
    expect(answer!.searchParams.get('kt')).toMatch(/^[0-9A-Za-z_-]{64}$/);
    expect(answer!.searchParams.get('ss')).toBe(first!.searchParams.get('ss'));
    expect(performance.now() - started).toBeGreaterThanOrEqual(90);
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init!.headers).get('user-agent')).toBe('SyntheticHost/1.0');
      expect(init!.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('sends the empty answer when the challenge has no text', async () => {
    const { fetcher, calls } = service([{ verified: true }]);
    const solve = vi.fn(() => 'never');
    await expect(mtcaptchaToken(SITE, lookup(fetcher, solve))).resolves.toBe('v1(synthetic-token)');
    expect(solve).not.toHaveBeenCalled();
    expect(calls().at(-1)!.searchParams.get('st')).toBe('$');
  });

  it('refuses after the bounded pictures, and keeps the challenge out of failures', async () => {
    const refused = service([{ textlen: 3 }, { textlen: 3 }]);
    await expect(mtcaptchaToken(SITE, lookup(refused.fetcher, () => 'abc', { pictures: 2 }))).rejects.toMatchObject({ kind: 'challenge' });
    expect(refused.calls().filter((url) => url.pathname.endsWith('/solvechallenge.json'))).toHaveLength(2);

    const failing = vi.fn<typeof fetch>(async () => json({}, { status: 500 }));
    const error = await mtcaptchaToken(SITE, lookup(failing, () => 'abc')).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ provider: 'Synthetic Post', status: 500 });
    expect(JSON.stringify(error)).not.toMatch(/getchallenge|MTPublic/);
  });

  it('gives up before a wait the deadline cannot hold', async () => {
    const { fetcher, calls } = service([{ textlen: 3, wait: '04c', verified: true }]);
    await expect(mtcaptchaToken(SITE, lookup(fetcher, () => 'abc', { deadlineMs: 2000 }))).rejects.toMatchObject({ kind: 'budget' });
    expect(calls().some((url) => url.pathname.endsWith('/solvechallenge.json'))).toBe(false);
  });

  it('treats a changed challenge as a schema change', async () => {
    const changed = vi.fn<typeof fetch>(async () => json({ code: 1200, result: { challenge: { ct: 'c1(6.synthetic-challenge-0)', hasTextChlg: true, textChlg: { textlen: 5 }, hasFoldChlg: false } } }));
    await expect(mtcaptchaToken(SITE, lookup(changed, () => 'abcde'))).rejects.toMatchObject({ kind: 'schema' });
    const closed = vi.fn<typeof fetch>(async () => json({ code: 1403, result: {} }));
    await expect(mtcaptchaToken(SITE, lookup(closed, () => 'abcde'))).rejects.toMatchObject({ kind: 'challenge' });
  });
});

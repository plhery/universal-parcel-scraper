import { createHash, randomUUID } from 'node:crypto';
import { BudgetExceededError, ChallengeError, SchemaError } from '../errors/index.js';
import { paused } from '../runner/pause.js';
import { isRecord } from '../types.js';
import { fetchBounded, parseJsonBytes, UpstreamHttpError, UpstreamNetworkError } from './boundedFetch.js';

/**
 * MTCaptcha's verification as its widget performs it over HTTP: a challenge,
 * the picture of its text, the widget's proof of work and the answer, which
 * buys a token the protected site checks once. The picture is read by the
 * caller's OCR; MTCaptcha ignores the answer's case.
 */
const API = 'https://service.mtcaptcha.com/mtcv1/api/';
// The widget's URL-safe base64 digits, in its order.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const SEED = /^[0-9A-Za-z_-]{64,256}$/;

export interface MtcaptchaSite {
  provider: string;
  sitekey: string;
  /** The protected page's host, as the widget reports it. */
  domain: string;
  /** The action the site names for its widget. */
  action: string;
}

export interface MtcaptchaLookup {
  fetcher?: typeof fetch;
  userAgent: string;
  signal: AbortSignal;
  /** When the token must be in hand, on the `performance.now()` clock. */
  deadline: number;
  budgetMs: number;
  /** Reads the picture's text. */
  solve: (image: Uint8Array, signal: AbortSignal) => Promise<string>;
  /** Pictures to read before giving up. */
  pictures?: number;
}

interface Challenge {
  ct: string;
  textLength: number | null;
  fold: { seed: string; slots: number; depth: number; early: boolean };
  waitMs: number;
}

function digits(value: string): number[] {
  return [...value].map((character) => DIGITS.indexOf(character));
}

function folded(values: readonly number[], rounds: number): number[] {
  const reversed = values.slice().reverse();
  const out = values.slice();
  let offset = 0;
  let carry = 0;
  let half = 0;
  for (let round = 0; round < rounds; round += 1) {
    offset += 1;
    for (let index = 0; index < values.length; index += 1) {
      out[index] = (Math.floor((out[index]! + reversed[(index + offset) % reversed.length]!) * 73 / 8) + carry + half) % 64;
      half = Math.floor(carry / 2);
      carry = Math.floor(out[index]! / 2);
    }
  }
  return out;
}

function hashed(values: readonly number[]): number {
  let hash = 0;
  for (const value of values) hash = ((hash << 5) - hash + value) | 0;
  return Math.abs(hash);
}

/** The widget's proof of work: two digits for each slot of the seed's fold. */
export function mtcaptchaFold(seed: string, slots: number, depth: number): string {
  let values = digits(seed);
  let answer = '';
  for (let slot = 0; slot < slots; slot += 1) {
    values = folded(values, 31);
    const hash = hashed(folded(values, depth)) % 4096;
    answer += DIGITS[hash >> 6]! + DIGITS[hash & 63]!;
  }
  return answer;
}

/**
 * The widget's record of the typing, keyed by the seed: the time to the first
 * key, then each key with the tenths of a second since the one before. MTCaptcha
 * refuses an answer whose record does not spell it.
 */
export function mtcaptchaKeystrokes(seed: string, typed: string, gaps: readonly number[]): string {
  const key = digits(seed.slice(0, 64));
  let previous = key[63]!;
  const record = key.map((value) => { const mixed = value ^ previous; previous = value; return mixed; });
  const mask = record.slice();
  if (typed) {
    const END = 63;
    const start = 6;
    record[0] = mask[0]! ^ Math.floor(start / 64);
    record[1] = mask[1]! ^ (start % 64);
    record[2] = mask[2]! ^ END;
    let position = 2;
    digits(typed).forEach((value, index) => {
      record[position] = mask[position]! ^ value;
      record[position + 1] = mask[position + 1]! ^ (index === 0 ? 0 : gaps[index - 1] ?? 6);
      record[position + 2] = mask[position + 2]! ^ END;
      position += 2;
    });
  }
  return record.map((value) => DIGITS[value]!).join('');
}

/** How long after the challenge opens MTCaptcha takes an answer, from its wait clue. */
export function mtcaptchaWaitMs(clue: string): number {
  const value = Number.parseInt(clue.slice(1), 16);
  return Number.isFinite(value) ? ((value * 47 + 11) % 256) * 100 : 0;
}

function challengeOf(payload: unknown, provider: string): Challenge {
  const result = isRecord(payload) && payload.code === 1200 && isRecord(payload.result) ? payload.result : null;
  const challenge = result && isRecord(result.challenge) ? result.challenge : null;
  if (!challenge || typeof challenge.ct !== 'string' || !/^[\w.(),-]{16,256}$/.test(challenge.ct)) {
    throw new ChallengeError(provider, `${provider} could not open an MTCaptcha challenge`);
  }
  let textLength: number | null = null;
  if (challenge.hasTextChlg === true) {
    const length = isRecord(challenge.textChlg) ? challenge.textChlg.textlen : null;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 3 || length > 10) throw new SchemaError(provider, `${provider} changed its MTCaptcha challenge`);
    textLength = length;
  }
  // The typing record is keyed by the proof of work's seed, so a challenge without one is a changed widget.
  const given = challenge.hasFoldChlg === true && isRecord(challenge.foldChlg) ? challenge.foldChlg : {};
  const { fseed, fslots, fdepth, preRes } = given;
  if (typeof fseed !== 'string' || !SEED.test(fseed) || typeof fslots !== 'number' || !Number.isInteger(fslots) || fslots < 1 || fslots > 200
    || typeof fdepth !== 'number' || !Number.isInteger(fdepth) || fdepth < 1 || fdepth > 200_000) {
    throw new SchemaError(provider, `${provider} changed its MTCaptcha challenge`);
  }
  const fold = { seed: fseed, slots: fslots, depth: fdepth, early: preRes === true };
  const clue = challenge.hasWaitChlg === true && isRecord(challenge.waitChlg) ? challenge.waitChlg.time : null;
  if (challenge.hasWaitChlg === true && (typeof clue !== 'string' || !/^[0-9a-f]{2,8}$/i.test(clue))) {
    throw new SchemaError(provider, `${provider} changed its MTCaptcha challenge`);
  }
  return { ct: challenge.ct, textLength, fold, waitMs: typeof clue === 'string' ? mtcaptchaWaitMs(clue) : 0 };
}

/** A verified token for one request to the protected site. */
export async function mtcaptchaToken(site: MtcaptchaSite, lookup: MtcaptchaLookup): Promise<string> {
  const { provider } = site;
  const left = () => {
    lookup.signal.throwIfAborted();
    const remaining = Math.floor(lookup.deadline - performance.now());
    if (remaining < 1) throw new BudgetExceededError(provider, lookup.budgetMs);
    return remaining;
  };
  const signature = `TH[${createHash('md5').update(`mtcap@mtcaptcha.com${site.sitekey}`).digest('hex')}]`;
  const session = `S1${randomUUID()}`;
  const call = async (path: string, query: Record<string, string | number>, maxBytes: number): Promise<unknown> => {
    const url = `${API}${path}?${Object.entries(query).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`;
    try {
      const { bytes } = await fetchBounded(url, { signal: lookup.signal, headers: { Accept: '*/*', 'User-Agent': lookup.userAgent } },
        { provider, timeoutMs: left(), maxBytes, fetcher: lookup.fetcher });
      return parseJsonBytes(bytes, provider);
    } catch (error) {
      // The request's diagnostics would carry the challenge and its answer.
      if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
      if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
      throw error;
    }
  };
  const common = { sk: site.sitekey, bd: site.domain, tsh: signature, act: site.action, ss: session, lf: 1, tl: '$', lg: 'en', tp: 's' };
  for (let picture = 0; picture < (lookup.pictures ?? 8); picture += 1) {
    const opened = performance.now();
    const challenge = challengeOf(await call('getchallenge.json', { ...common, rt: Date.now() }, 20_000), provider);
    const proof = mtcaptchaFold(challenge.fold.seed, challenge.fold.slots, challenge.fold.depth);
    let answer = '$';
    if (challenge.textLength !== null) {
      const reply = await call('getimage.json', { sk: site.sitekey, ct: challenge.ct, fa: challenge.fold.early ? proof : '$', ss: session }, 400_000);
      const image = isRecord(reply) && reply.code === 1200 && isRecord(reply.result) && isRecord(reply.result.img) ? reply.result.img.image64 : null;
      if (typeof image !== 'string' || image.length > 300_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new SchemaError(provider, `${provider} changed its MTCaptcha picture`);
      const read = (await lookup.solve(Buffer.from(image, 'base64'), lookup.signal)).replace(/[^a-z0-9]/gi, '');
      left();
      // A misread length is never sent: a fresh picture costs less than a refused answer.
      if (read.length !== challenge.textLength) continue;
      answer = read;
    }
    const wait = opened + challenge.waitMs - performance.now();
    if (wait > 0) {
      if (wait >= left()) throw new BudgetExceededError(provider, lookup.budgetMs);
      if (!await paused(wait, lookup.signal)) lookup.signal.throwIfAborted();
    }
    const gaps = [...answer].map(() => 5 + Math.floor(Math.random() * 6));
    const verified = await call('solvechallenge.json', { ...common, ct: challenge.ct, st: answer, rt: Date.now(), fa: proof, qh: '$',
      kt: mtcaptchaKeystrokes(challenge.fold.seed, answer === '$' ? '' : answer, gaps), fs: challenge.fold.seed }, 20_000);
    const result = isRecord(verified) && verified.code === 1200 && isRecord(verified.result) && isRecord(verified.result.verifyResult)
      ? verified.result.verifyResult : null;
    if (!result || typeof result.isVerified !== 'boolean') throw new SchemaError(provider, `${provider} changed its MTCaptcha verification`);
    if (!result.isVerified) continue;
    const token = isRecord(result.verifiedToken) ? result.verifiedToken.vt : null;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(token)) throw new SchemaError(provider, `${provider} changed its MTCaptcha token`);
    return token;
  }
  throw new ChallengeError(provider, `${provider} refused the MTCaptcha answers`);
}

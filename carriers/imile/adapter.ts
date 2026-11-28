import { constants, createHash, createPublicKey, publicEncrypt, type KeyObject } from 'node:crypto';
import { accepted, recognizeFromLookup, type AdapterFactory, type TrackingContext } from '../../core/adapter/index.js';
import {
  BudgetExceededError, carrierErrorKind, ChallengeError, IndeterminateError, NotFoundError, RateLimitedError, retryAfterMsOf, SchemaError,
  TransportError,
} from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { HoldKind, serviceTag } from '../../core/runner/holds.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, isNetworkFailure } from '../../core/runner/networkRetry.js';
import { paused } from '../../core/runner/pause.js';
import { errorTypeOf, NOOP_RECORDER, outcomeOf, safeRecorder, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { transportOf } from '../../core/transport/transportOf.js';
import { CainiaoTracker } from '../aliexpress/adapter.js';
import { CAINIAO, cainiaoScans, withCainiaoLeg } from './cainiao.js';
import { IMILE_MAX_BYTES, normalizeImileNumber, parseImile, PROVIDER } from './parser.js';

const ORIGIN = 'https://www.imile.com';
/** The lookup the tracking page on www.imile.com makes for the number in its address. */
export const IMILE_API = `${ORIGIN}/saastms/mobileWeb/track/query`;

/** How the page signs a lookup: the RSA public key the `sign` header encrypts the number with, and the salt of the MD5 `code`. */
export interface ImileSigning {
  key: string;
  salt: string;
}

/** The values the tracking page's script signed its lookups with, the same for every visitor. */
export const IMILE_SIGNING: Readonly<ImileSigning> = {
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3dFPiKNZwt+HoBbPAG/t7kZC2k3pBX2eCl5LeyeW8woNuEV5bA5kB9Y9KKTOQng62ERGPLwi84CdIB8s265ljQUib//iO3jVrZesJueO5Xu+s80s3Z/89jgJleT1XawN1GubgkGXOoT1a7tvX8+aItkGgR//48ELqJVVUL+yGsBtXxFjNmOEWxBJNQuwAf9yWcCIl1enD60GjZjPWrsfw8QUqam7K5e45ealcPEYGenNePwuPpCq6twdD0YYYzKdRN0dZP1uTviFpNfph90c9YgQ8kgDkRMcpjVv6KZ+bg5JZ4sK6LkV4vwOjPijisthHBvUXhu3fyhMgvoDO/j5gwIDAQAB', // gitleaks:allow
  salt: 'imileTrackQuery2024', // gitleaks:allow
};

/**
 * Public samples (numbers.json) whose shipments iMile still answers. One of them answering, signed
 * with the values in use, shows the service accepts the values; its page no longer holds them.
 */
export const IMILE_SIGNING_SAMPLES = ['6120924763844', '6061325954939'] as const;
// How long a sample's answer stands: an empty reply in that time is an unknown number.
const SIGNING_CHECKED_MS = 60 * 60_000;
const REDIRECTS = [301, 302, 303, 307, 308];
// Bot checks Cloudflare, in front of the site, could put in place of a reply.
const CHALLENGE = /_cf_chl_opt|cf-turnstile|challenge-platform|<title>\s*(?:Just a moment|Attention Required)/i;
const DEFAULT_BUDGET_MS = 20_000;
// Cainiao answers within a second or two; it gets half of what iMile left, at most this.
const CAINIAO_MS = 8_000;
// Less than this left for Cainiao is no time for a request.
const CAINIAO_MIN_MS = 250;
// iMile refuses a lookup that comes within about a second of the one before it, with HTTP 429
// and `TRACK_QUERY_RATE_LIMIT`, naming no wait. Recognition's read and the lookup after it come
// that close, and so do two parcels' lookups. A refused read is sent once more after this long.
const THROTTLE_WAIT_MS = 1_500;
// What the read sent again after the throttle keeps at least for its request.
const RESEND_MS = 2_000;
// How far apart one transport's lookups go out, so that its own do not meet that throttle.
const TURN_MS = 1_100;

/**
 * When each transport may next send iMile a lookup. iMile judges an address, so every tracker in
 * the process that sends through the same fetcher takes turns: two parcels' checks, and
 * recognition's read and the lookup after it. A restart forgets them.
 */
const turns = new WeakMap<object, { next: number }>();
const GLOBAL_FETCH = {};

/** How long Cainiao's answer that it has no record of a number spares the number Cainiao's read. */
export const CAINIAO_UNKNOWN_MS = 24 * 3_600_000;
/**
 * How long a record Cainiao keeps under the number for a parcel it does not name iMile on spares the
 * number Cainiao's read: once iMile has scanned the parcel, such a record is most likely another
 * network's parcel, though Cainiao can name iMile later.
 */
export const CAINIAO_UNCONFIRMED_MS = 6 * 3_600_000;
/** The most numbers one transport keeps Cainiao's answer for; the oldest answer goes first. */
const CAINIAO_UNKNOWN_KEPT = 10_000;

/**
 * Until when each number Cainiao answered it has no record of goes unasked, by transport: most iMile
 * parcels never passed through Cainiao, and every answered check asked it again within Cainiao's pace,
 * which AliExpress's lookups share. A restart forgets them unless the host keeps adapters' holds
 * (`keepAdapterHolds`); the answers it takes up hold for every transport. A hold names the number by
 * its `serviceTag` only, so the host's store keeps no tracking number: many numbers share a tag, and
 * one that shares a saved tag goes without Cainiao's read for that day at most.
 */
const cainiaoUnknown = new WeakMap<object, Map<string, number>>();
const savedUnknown = new Map<string, number>();
const unknownHolds = new HoldKind('imile-cainiao-unknown', (tag, until) => {
  savedUnknown.set(tag, Math.max(savedUnknown.get(tag) ?? 0, Math.min(until, Date.now() + CAINIAO_UNKNOWN_MS)));
  if (savedUnknown.size > CAINIAO_UNKNOWN_KEPT) savedUnknown.delete(savedUnknown.keys().next().value!);
});

function unknownToCainiao(fetcher: typeof fetch | undefined): Map<string, number> {
  const key = transportOf(fetcher) ?? GLOBAL_FETCH;
  let numbers = cainiaoUnknown.get(key);
  if (!numbers) cainiaoUnknown.set(key, numbers = new Map<string, number>());
  return numbers;
}

function selfPaced(waitMs: number): RateLimitedError {
  return new RateLimitedError(PROVIDER, waitMs, 'iMile was asked less than a second ago; no lookup until its turn', { reason: 'self_paced' });
}

/**
 * Waits for the transport's next turn and takes it; the time waited. A lookup whose turn leaves
 * no time for its request fails as our own pacing, with the wait, and sends nothing.
 */
async function takeTurn(fetcher: typeof fetch | undefined, signal: AbortSignal, timeoutMs: number): Promise<number> {
  const key = transportOf(fetcher) ?? GLOBAL_FETCH;
  let turn = turns.get(key);
  if (!turn) turns.set(key, turn = { next: 0 });
  const now = Date.now();
  const wait = Math.max(0, turn.next - now);
  if (wait > 0 && wait + RESEND_MS > timeoutMs) throw selfPaced(wait);
  turn.next = now + wait + TURN_MS;
  // A wait the lookup's end cuts short leaves the pacing as the answer; the turn stays taken.
  if (wait > 0 && !await paused(wait, signal)) throw selfPaced(Math.max(1, now + wait - Date.now()));
  return wait;
}

/** The wait before a throttled read is sent again: iMile's own, when it names a longer one. Null for any other failure. */
function throttleWaitMs(error: unknown): number | null {
  return carrierErrorKind(error) === 'rate_limited' ? Math.max(THROTTLE_WAIT_MS, retryAfterMsOf(error) ?? 0) : null;
}

function publicKey(key: string): KeyObject {
  return createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
}

/** The page's `code` and `sign` for a number: the MD5 of the number and the salt, and the number encrypted with the key. */
export function imileSignature(number: string, signing: ImileSigning): { code: string; sign: string } {
  return {
    code: createHash('md5').update(`${number}${signing.salt}`).digest('hex'),
    sign: publicEncrypt({ key: publicKey(signing.key), padding: constants.RSA_PKCS1_PADDING }, Buffer.from(number)).toString('base64'),
  };
}

function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (cause) {
    if (CHALLENGE.test(body.slice(0, 64_000))) throw new ChallengeError(PROVIDER, 'iMile answered with a browser check', { cause });
    throw new SchemaError(PROVIDER, 'iMile returned a reply that is not JSON', { cause });
  }
}

export class ImileTracker {
  readonly #signing: Readonly<ImileSigning>;
  // When a public sample last showed the values are accepted.
  #checkedAt = Number.NEGATIVE_INFINITY;
  readonly #cainiao: CainiaoTracker;

  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number;
    signing?: Readonly<ImileSigning> } = {}) {
    this.#signing = options.signing ?? IMILE_SIGNING;
    this.#cainiao = new CainiaoTracker({ fetcher: options.fetcher, userAgent: options.userAgent, timeoutMs: CAINIAO_MS });
  }

  /**
   * iMile's answer, with Cainiao's leg in front of its history unless
   * `cainiao` is false. Cainiao is asked only once iMile has answered with
   * scans, and its failure leaves iMile's answer as it is.
   */
  async fetch(raw: string, context: TrackingContext = {}, { cainiao = true }: { cainiao?: boolean } = {}): Promise<CarrierResult> {
    const number = normalizeImileNumber(raw);
    const started = performance.now();
    const budgetMs = context.budgetMs ?? DEFAULT_BUDGET_MS;
    let attempts = 0;
    const result = await this.#imile(number, { signal: context.signal, budgetMs }, (attempt) => { attempts = attempt; });
    if (!cainiao) return result;
    return this.#withCainiao(number, result, context.signal, budgetMs - (performance.now() - started), attempts + 1);
  }

  async #imile(number: string, context: Required<Pick<TrackingContext, 'budgetMs'>> & TrackingContext,
    attempted: (attempt: number) => void): Promise<CarrierResult> {
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const deadline = performance.now() + timeoutMs;
      const left = () => Math.max(1, Math.floor(deadline - performance.now()));
      try {
        return parseImile(await this.#query(number, this.#signing, signal, left()), number);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        // A sign the service does not accept gets the same empty reply as an
        // unknown number, so a public sample signed the same way must still be answered.
        await this.#checkSigning(signal, left);
        throw error;
      }
    };
    const deadline = performance.now() + context.budgetMs;
    // The throttle is sat out only when its wait and the request after it fit in what is left.
    const throttleFits = (error: unknown) => {
      const wait = throttleWaitMs(error);
      return wait !== null && wait + RESEND_MS <= deadline - performance.now();
    };
    // A request that fails to reach the site, or hangs, gets one more try: the
    // first gets half of the budget, so the retry fits in the rest. So does one
    // iMile throttled, once the wait is over.
    return runSteps({ carrier: 'imile', budgetMs: context.budgetMs, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs, attempt }) => { attempted(attempt); return read(signal, firstAttemptMs(remainingMs)); } },
      { id: 'retry', recovers: (error) => isNetworkFailure(error) || throttleFits(error),
        run: async ({ signal, remainingMs, attempt, previousError }) => {
          attempted(attempt);
          const wait = isNetworkFailure(previousError) ? null : throttleWaitMs(previousError);
          if (wait === null) return read(signal, remainingMs);
          // A wait the lookup's end cuts short leaves the throttle as the answer.
          if (wait + RESEND_MS > remainingMs || !await paused(wait, signal)) throw previousError;
          return read(signal, remainingMs - wait);
        } },
    ]);
  }

  /**
   * Cainiao's leg of the parcel in front of iMile's history, recorded as the
   * `cainiao` step. Cainiao gets half of the time iMile left, so iMile's
   * answer comes back inside the budget whatever Cainiao does. Any failure,
   * a challenge, a rate limit, an unknown number or a changed reply, is
   * recorded with its kind and returns iMile's answer unchanged.
   */
  async #withCainiao(number: string, result: CarrierResult, signal: AbortSignal | undefined, remainingMs: number,
    attempt: number): Promise<CarrierResult> {
    const recorder = safeRecorder(this.options.recorder ?? NOOP_RECORDER);
    const started = performance.now();
    const record = (error?: unknown) => recorder.step({
      carrier: 'imile', step: 'cainiao', attempt, outcome: error === undefined ? 'ok' : outcomeOf(error),
      errorType: error === undefined ? null : errorTypeOf(error), durationMs: Math.max(0, performance.now() - started),
      fallbackFrom: null, fallbackReason: null, fallbackErrorType: null, ...(error === undefined ? {} : { error }),
    });
    // A number Cainiao had no record of in the last day, or a record that did not name iMile in the last hours, is not asked again.
    const unknown = unknownToCainiao(this.options.fetcher);
    const now = (this.options.now ?? Date.now)();
    const tag = serviceTag(number);
    const until = Math.max(unknown.get(number) ?? 0, savedUnknown.get(tag) ?? 0);
    if (until > now) return result;
    unknown.delete(number);
    savedUnknown.delete(tag);
    const budgetMs = Math.min(CAINIAO_MS, Math.floor(remainingMs / 2));
    try {
      if (budgetMs < CAINIAO_MIN_MS) throw new BudgetExceededError(CAINIAO, budgetMs);
      const merged = withCainiaoLeg(result, cainiaoScans(await this.#cainiao.detail(number, { signal, budgetMs }), number));
      record();
      return merged;
    } catch (error) {
      record(error);
      const holdMs = error instanceof NotFoundError ? CAINIAO_UNKNOWN_MS
        : error instanceof IndeterminateError && error.reason === 'carrier_unconfirmed' ? CAINIAO_UNCONFIRMED_MS : 0;
      if (holdMs) {
        unknown.set(number, now + holdMs);
        if (unknown.size > CAINIAO_UNKNOWN_KEPT) unknown.delete(unknown.keys().next().value!);
        unknownHolds.save(tag, now + holdMs);
      }
      return result;
    }
  }

  async #query(number: string, signing: ImileSigning, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const { code, sign } = imileSignature(number, signing);
    const waited = await takeTurn(this.options.fetcher, signal, timeoutMs);
    const { response, bytes } = await fetchBounded(`${IMILE_API}?waybillNo=${encodeURIComponent(number)}&code=${code}`, { method: 'GET', signal,
      headers: { Accept: 'application/json', lang: 'en_US', sign, 'User-Agent': userAgentOf(this.options.userAgent) } },
    { provider: PROVIDER, timeoutMs: timeoutMs - waited, maxBytes: IMILE_MAX_BYTES, redirect: 'manual', fetcher: this.options.fetcher,
      allowHttpStatuses: [...REDIRECTS, 404, 410] });
    if (REDIRECTS.includes(response.status)) throw new TransportError(PROVIDER, 'iMile redirected its tracking lookup');
    // The page reads a missing parcel from a 200 reply; a 404 is a moved route.
    if (response.status === 404 || response.status === 410) throw new TransportError(PROVIDER, 'iMile tracking lookup is unavailable');
    return json(decodeText(bytes));
  }

  /** Whether iMile accepts the values in use, asked of a public sample once an hour. */
  async #checkSigning(signal: AbortSignal, left: () => number): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    if (now - this.#checkedAt < SIGNING_CHECKED_MS) return;
    for (const sample of IMILE_SIGNING_SAMPLES) {
      try {
        parseImile(await this.#query(sample, this.#signing, signal, left()), sample);
      } catch (error) {
        if (error instanceof NotFoundError) continue;
        throw error;
      }
      this.#checkedAt = now;
      return;
    }
    throw new SchemaError(PROVIDER, 'iMile no longer answers its public samples signed with the values in use');
  }
}

export const adapter: AdapterFactory = (environment) => {
  const tracker = new ImileTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return {
    id: 'imile', recordsSteps: true, steps: ['direct', 'retry', 'cainiao'],
    track: (input, context) => tracker.fetch(input.number, context),
    // Recognition asks iMile alone: Cainiao's record of a number is no evidence that iMile knows it.
    recognize: (number, context) => recognizeFromLookup(() => tracker.fetch(number, context, { cainiao: false }),
      () => accepted(() => normalizeImileNumber(number))),
  };
};

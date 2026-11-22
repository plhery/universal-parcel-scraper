import type { AdapterFactory, TrackingContext } from '../../core/adapter/index.js';
import { ChallengeError, TransportError } from '../../core/errors/index.js';
import type { CarrierResult } from '../../core/result/index.js';
import { runSteps } from '../../core/runner/index.js';
import { firstAttemptMs, networkRetryStep } from '../../core/runner/networkRetry.js';
import { NOOP_RECORDER, type StepRecorder } from '../../core/telemetry/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { JINGGUANG_ENDPOINT, JINGGUANG_PAGE, jingguangJson, normalizeJingguangNumber, parseJingguang, PROVIDER } from './parser.js';

export { parseJingguang } from './parser.js';
const REDIRECTS = [301, 302, 303, 307, 308];
// The AES-256-CBC key and IV the search page's script gives every visitor. CryptoJS uses the first
// sixteen bytes of the IV string.
const PAGE_KEY = 'a6f1b751b31a379360ab170ff7c2451c'; // gitleaks:allow
const PAGE_IV = '8a8ff614f12c0724'; // gitleaks:allow
// The letters and digits the page draws its code from.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * The check the search page sends beside the waybill: the four-character code it draws on a
 * canvas, and that code with the time, encrypted under the page's key. The server compares the
 * two; it never draws the code itself.
 */
export async function jingguangCheck(code: string, now: number): Promise<{ code: string; key: string }> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PAGE_KEY), { name: 'AES-CBC' }, false, ['encrypt']);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new TextEncoder().encode(PAGE_IV) }, key,
    new TextEncoder().encode(JSON.stringify({ time: now, code }))));
  return { code, key: btoa(String.fromCharCode(...sealed)) };
}

function drawCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), value => ALPHABET[value % ALPHABET.length]).join('');
}

export class JingguangTracker {
  constructor(private readonly options: { fetcher?: typeof fetch; recorder?: StepRecorder; userAgent?: string; now?: () => number; code?: () => string } = {}) {}

  fetch(raw: string, context: TrackingContext = {}): Promise<CarrierResult> {
    context.signal?.throwIfAborted();
    const number = normalizeJingguangNumber(raw);
    const read = async (signal: AbortSignal, timeoutMs: number): Promise<CarrierResult> => {
      const check = await jingguangCheck((this.options.code ?? drawCode)(), (this.options.now ?? Date.now)());
      const url = `${JINGGUANG_ENDPOINT}?${new URLSearchParams({ ...check, billcode: number })}`;
      const { response, bytes } = await fetchBounded(url, { method: 'GET', signal, headers: {
        Accept: 'application/json, text/plain, */*', Referer: JINGGUANG_PAGE, 'User-Agent': userAgentOf(this.options.userAgent),
      } }, { provider: PROVIDER, fetcher: this.options.fetcher, maxBytes: 1_000_000, timeoutMs: Math.max(1, Math.floor(timeoutMs)),
        redirect: 'manual', allowHttpStatuses: [...REDIRECTS, 401, 403, 404, 410] });
      if ([401, 403].includes(response.status)) throw new ChallengeError(PROVIDER, 'Jingguang refused its guest request');
      // An unknown waybill is HTTP 200 too; anything else is a moved route.
      if (response.status !== 200) throw new TransportError(PROVIDER, 'Jingguang tracking endpoint moved', { status: response.status });
      return parseJingguang(jingguangJson(decodeText(bytes)), number);
    };
    // A request that fails to reach the server, or hangs, gets one more try with a new check.
    return runSteps({ carrier: 'jingguang-logistics', budgetMs: context.budgetMs ?? 15_000, signal: context.signal,
      recorder: this.options.recorder ?? NOOP_RECORDER }, [
      { id: 'direct', run: ({ signal, remainingMs }) => read(signal, firstAttemptMs(remainingMs)) },
      networkRetryStep(({ signal, remainingMs }) => read(signal, remainingMs)),
    ]);
  }
}

export const adapter: AdapterFactory = environment => {
  const tracker = new JingguangTracker({ fetcher: environment.fetcher, recorder: environment.recorder, userAgent: environment.userAgent });
  return { id: 'jingguang-logistics', recordsSteps: true, steps: ['direct', 'retry'], track: (input, context) => tracker.fetch(input.number, context) };
};

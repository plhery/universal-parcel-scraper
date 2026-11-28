import { DateTime } from 'luxon';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeKoreanAirCargoNumber, parseKoreanAirCargoTracking, provider } from './parser.js';

const origin = 'https://cargo.koreanair.com';
const tracker = `${origin}/en/tracking`;
const service = `${origin}/cargoportal/services/trackawb`;
const verification = /<title>\s*(?:Access Denied|Just a moment|Attention Required)|\/_sec\/cp_challenge|_Incapsula_Resource/i;
// Drupal's session ids can hold commas.
const cookiePair = /^([\w.-]{1,64})=([^\s;]{1,4096})/;

/** The guest session the tracking page opens: Drupal writes its id into the page's settings and sets it, with a token, as cookies. */
export function guestSession(html: string, setCookies: readonly string[]): { id: string; cookie: string } {
  const id = /"session_id":"([\w,.-]{20,128})"/.exec(html)?.[1];
  const cookies = new Map<string, string>();
  for (const header of setCookies) {
    const [, name, value] = cookiePair.exec(header) ?? [];
    if (name && value) cookies.set(name, value);
  }
  if (!id || !cookies.has('Authorization')) {
    if (verification.test(html)) throw new ChallengeError(provider, 'Korean Air Cargo returned a verification page');
    throw new IndeterminateError(provider, 'Korean Air Cargo did not open a tracking session', { reason: 'session_rejected' });
  }
  return { id, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
}

/** The request the tracker's script sends for one waybill, as a guest. */
export function trackRequest(number: string, sessionId: string, now: DateTime): string {
  return JSON.stringify({
    payLoad: [{ awbPrefix: number.slice(0, 3), awbDocNo: number.slice(3) }],
    generalInfo: {
      sessionId, lang: 'EN',
      time: now.setZone('Asia/Seoul').toFormat('d LLL yyyy H:m'),
      txnId: Math.random().toString(36).slice(2, 11) + now.toMillis(),
    },
    // The script's defaults for a visitor who has not signed in.
    userInfo: { userId: '', agentCode: '', region: 'Korea', branch: '', userType: 'GUEST' },
  });
}

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeKoreanAirCargoNumber(input.number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const userAgent = userAgentOf(environment.userAgent);
        const read = async (url: string, init: { headers: Record<string, string>; method?: string; body?: string }) => {
          signal.throwIfAborted();
          const left = Math.floor(deadline - performance.now());
          if (left <= 0) throw new BudgetExceededError(provider, remainingMs);
          const { response, bytes } = await fetchBounded(url, {
            signal, ...init, headers: { ...init.headers, 'User-Agent': userAgent },
          }, { provider, fetcher: environment.fetcher, timeoutMs: left, maxBytes: 1_000_000, allowHttpStatuses: [403] });
          const body = decodeText(bytes);
          if (response.status === 403) {
            throw new ChallengeError(provider, verification.test(body) ? 'Korean Air Cargo returned a verification page' : 'Korean Air Cargo refused the request');
          }
          return { response, body };
        };

        const page = await read(tracker, { headers: { Accept: 'text/html' } });
        const session = guestSession(page.body, page.response.headers.getSetCookie());
        const reply = await read(service, {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json',
            Cookie: session.cookie, Origin: origin, Referer: tracker,
          },
          body: trackRequest(number, session.id, DateTime.now()),
        });
        let data: unknown;
        try {
          data = JSON.parse(reply.body);
        } catch (cause) {
          if (verification.test(reply.body)) throw new ChallengeError(provider, 'Korean Air Cargo returned a verification page');
          throw new SchemaError(provider, 'Korean Air Cargo returned unreadable tracking JSON', { cause });
        }
        return parseKoreanAirCargoTracking(data, number);
      },
    }]);
  },
});

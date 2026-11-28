import { load } from 'cheerio';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { BudgetExceededError, ChallengeError, IndeterminateError, SchemaError, UpstreamHttpError, UpstreamNetworkError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { normalizeAlaskaAirCargoNumber, parseAlaskaAirCargo, provider } from './parser.js';

const origin = 'https://alaska-icargo.ibsplc.aero';
const landing = `${origin}/icargoportal/portal/loginFlow`;
// The tracking page's script posts its form here and puts the fragment in its tracking panel.
const search = `${origin}/icargoportal/portal/trackshipments?fragments=trackPanel`;
const verification = /<title>\s*(?:Access Denied|Just a moment|Attention Required)|cf-chl|cf-turnstile|_Incapsula_Resource/i;
const cookiePair = /^([\w.-]{1,64})=([^\s;]{1,4096})/;
const form = 'trackingFilterWidgetModel.trackingFilterVO';

/** The guest session the portal's landing page opens: its cookies and the form token its scripts send back. */
export function guestSession(html: string, setCookies: readonly string[]): { token: string; cookie: string } {
  const token = load(html)('input[name="_token_"]').first().attr('value')?.trim() ?? '';
  if (!/^[\w-]{8,128}$/.test(token)) {
    if (verification.test(html)) throw new ChallengeError(provider, 'Alaska Air Cargo returned a verification page');
    throw new SchemaError(provider, 'The Alaska Air Cargo portal no longer gives its page a form token');
  }
  const cookies = new Map<string, string>();
  for (const header of setCookies) {
    const [, name, value] = cookiePair.exec(header) ?? [];
    if (name && value) cookies.set(name, value);
  }
  if (!cookies.has('JSESSIONID')) {
    throw new IndeterminateError(provider, 'The Alaska Air Cargo portal did not open a guest session', { reason: 'session_rejected' });
  }
  return { token, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
}

/** The tracking form's fields as the page's script serializes them for one waybill. */
export function trackRequest(number: string): string {
  return new URLSearchParams([
    [`${form}.screenStatus`, ''],
    [`${form}.shipments`, '0'],
    [`${form}.awbVO.shipmentPrefix`, number.slice(0, 3)],
    [`${form}.fromScreen`, ''],
    [`${form}.trackingShipmentId`, ''],
    [`${form}.awbVO.shipmentPrefixArray[0]`, number.slice(0, 3)],
    [`${form}.awbVO.documentNumberArray[0]`, number.slice(3)],
    ['tokenString', ''],
  ]).toString();
}

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = normalizeAlaskaAirCargoNumber(input.number);
    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 15_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const deadline = performance.now() + remainingMs;
        const userAgent = userAgentOf(environment.userAgent);
        const read = async (url: string, init: { headers: Record<string, string>; method?: string; body?: string }, allowHttpStatuses: number[]) => {
          signal.throwIfAborted();
          const left = Math.floor(deadline - performance.now());
          if (left <= 0) throw new BudgetExceededError(provider, remainingMs);
          try {
            const { response, bytes } = await fetchBounded(url, { signal, ...init, headers: { ...init.headers, 'User-Agent': userAgent } }, {
              provider, fetcher: environment.fetcher, timeoutMs: left, maxBytes: 1_000_000, allowHttpStatuses,
            });
            return { response, body: decodeText(bytes) };
          } catch (error) {
            // The shared diagnostics would carry the guest session's cookie and token.
            if (error instanceof UpstreamHttpError) throw new UpstreamHttpError(error.provider, error.status, error.retryAfterMs);
            if (error instanceof UpstreamNetworkError) throw new UpstreamNetworkError(error.provider, error.cause);
            throw error;
          }
        };

        const page = await read(landing, { headers: { Accept: 'text/html' } }, [403]);
        if (page.response.status === 403) throw new ChallengeError(provider, 'Alaska Air Cargo refused its portal page');
        const session = guestSession(page.body, page.response.headers.getSetCookie());
        const reply = await read(search, {
          method: 'POST',
          headers: {
            Accept: 'text/html, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Cookie: session.cookie, _token_: session.token, 'X-Requested-With': 'XMLHttpRequest', Origin: origin, Referer: landing,
          },
          body: trackRequest(number),
        }, [400, 403, 408]);
        const { status, headers } = reply.response;
        if (status === 403 || verification.test(reply.body)) throw new ChallengeError(provider, 'Alaska Air Cargo returned a verification page');
        // The page's scripts read either as the guest session lapsing.
        if (status === 408 || headers.get('session-expired') !== null) {
          throw new IndeterminateError(provider, 'The Alaska Air Cargo portal ended the guest session', { reason: 'session_rejected' });
        }
        // The portal answers a form without its token with HTTP 400.
        if (status === 400) throw new SchemaError(provider, 'Alaska Air Cargo refused the tracking form as sent');
        return parseAlaskaAirCargo(reply.body, headers.get('applicationmessages'), number);
      },
    }]);
  },
});

import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://casillerousa.serviciosexpresos.com';
const portal = origin + '/index.php';
const endpoint = origin + '/modulos/General/controller/BuscarTracking.php';
const verification = /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,40}$/.test(number)) throw new InvalidInputError(provider, 'Enter a Servicios Expresos guide');

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, new CookieJar());
        const options = { provider, fetcher, timeoutMs: remainingMs, maxBytes: 350_000, allowHttpStatuses: [403] };
        const userAgent = userAgentOf(environment.userAgent);
        const page = await fetchBounded(portal, { headers: { Accept: 'text/html', 'User-Agent': userAgent }, signal }, options);
        const html = decodeText(page.bytes);
        const $ = load(html);
        if (page.response.status === 403 || verification.test(html) || $('.g-recaptcha, .h-captcha, .cf-turnstile').length) {
          throw new ChallengeError(provider, 'Servicios Expresos requires verification');
        }
        const token = $('meta[name="csrf-token"]').attr('content');
        if (!token || !$('#Tracking, #TrackingSmall').length) {
          throw new SchemaError(provider, 'Servicios Expresos omitted its public tracking form');
        }

        const reply = await fetchBounded(endpoint, {
          method: 'POST', body: new URLSearchParams({ Guia: number }), signal,
          headers: {
            Accept: 'application/json, text/javascript, */*; q=0.01', Origin: origin, Referer: portal,
            'User-Agent': userAgent, 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': token,
          },
        }, options);
        const body = decodeText(reply.bytes);
        if (reply.response.status === 403 || verification.test(body)) {
          throw new ChallengeError(provider, 'Servicios Expresos refused the guest lookup');
        }
        return parseTracking(body, number);
      },
    }]);
  },
});

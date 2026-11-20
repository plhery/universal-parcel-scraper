import { load } from 'cheerio';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://www.hrlcargo.com';
const portal = origin + '/track/';
const verification = /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|_Incapsula_Resource/i;

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const number = input.number.trim();
    if (!/^[A-Z0-9/-]{1,40}$/i.test(number)) throw new InvalidInputError(provider, 'Enter an HRL Cargo docket or LR number');

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const options = { provider, fetcher: environment.fetcher, timeoutMs: remainingMs, maxBytes: 350_000, allowHttpStatuses: [403] };
        const headers = { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) };
        const page = await fetchBounded(portal, { headers, signal }, options);
        const html = decodeText(page.bytes);
        const $ = load(html);
        if (page.response.status === 403 || verification.test(html) || $('.g-recaptcha, .h-captcha, .cf-turnstile').length) {
          throw new ChallengeError(provider, 'HRL Cargo requires verification');
        }
        const search = $('form').filter((_, form) => $(form).find('input[name="docno"]').length === 1);
        const fields = search.find('input[type="hidden"][name^="$ACTION_"]');
        if (search.length !== 1 || !fields.length) throw new SchemaError(provider, 'HRL Cargo omitted its guest tracking form');

        const form = new FormData();
        for (const input of fields.toArray()) {
          const field = $(input);
          const name = field.attr('name');
          if (name) form.append(name, field.attr('value') ?? '');
        }
        form.append('docno', number);
        const reply = await fetchBounded(portal, {
          method: 'POST', body: form, headers: { ...headers, Origin: origin, Referer: portal }, signal,
        }, options);
        const body = decodeText(reply.bytes);
        if (reply.response.status === 403 || verification.test(body)) {
          throw new ChallengeError(provider, 'HRL Cargo refused the public docket lookup');
        }
        return parseTracking(body, number);
      },
    }]);
  },
});

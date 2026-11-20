import { load } from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import type { AdapterFactory } from '../../core/adapter/index.js';
import { ChallengeError, InvalidInputError, SchemaError } from '../../core/errors/index.js';
import { runSteps } from '../../core/runner/index.js';
import { decodeText, fetchBounded, userAgentOf } from '../../core/transport/index.js';
import { parseTracking, provider } from './parser.js';

const origin = 'https://chorus.thaicargo.com';
const path = '/skychain/app';
const portal = origin + path + '?service=page%2Fnwp%3ATrackshipmt';
const verification = /<title>\s*(?:Just a moment|Access Denied|Security Check)|cf-chl|verify you are human/i;

function readPage({ bytes, response }: Awaited<ReturnType<typeof fetchBounded>>) {
  const html = decodeText(bytes);
  const page = load(html);
  if (response.status === 403 || verification.test(html) || page('.g-recaptcha, .h-captcha, .cf-turnstile').length) {
    throw new ChallengeError(provider, 'THAI Cargo requires verification');
  }
  return page;
}

export const adapter: AdapterFactory = environment => ({
  id: provider,
  recordsSteps: true,
  steps: ['direct'],
  async track(input, context = {}) {
    const serial = /^(?:217[\s-]?)?(\d{8})$/.exec(input.number.trim())?.[1];
    if (!serial) throw new InvalidInputError(provider, 'Enter a THAI Cargo 217 air waybill or eight-digit serial');

    return runSteps({
      carrier: provider, recorder: environment.recorder, signal: context.signal, budgetMs: context.budgetMs ?? 18_000,
    }, [{
      id: 'direct',
      async run({ signal, remainingMs }) {
        const fetcher = makeFetchCookie(environment.fetcher ?? fetch, new CookieJar());
        const options = { provider, fetcher, timeoutMs: remainingMs, maxBytes: 500_000, allowHttpStatuses: [403] };
        const headers = { Accept: 'text/html', 'User-Agent': userAgentOf(environment.userAgent) };
        const landing = readPage(await fetchBounded(portal, { headers, signal }, options));
        const form = landing('form[name="Form1"]');
        const submit = form.find('input[type="submit"][name="$JSubmit$0"]').attr('value');
        if (form.attr('action') !== path || !submit || !form.find('input[name="txtNumber"]').length) {
          throw new SchemaError(provider, 'THAI Cargo omitted its public waybill form');
        }

        const fields = new URLSearchParams(form.serializeArray().map(({ name, value }) => [name, value]));
        fields.set('txtPrefix', '217');
        fields.set('txtNumber', serial);
        // This flag is set by the visible Track button. The button leaves the permission code blank.
        fields.set('trackForm_hdnLastPermissionCheck', 'Y');
        fields.set('$JSubmit$0', submit);
        const reply = readPage(await fetchBounded(origin + path, {
          method: 'POST', body: fields, signal, headers: { ...headers, Origin: origin, Referer: portal },
        }, options));
        return parseTracking(reply, '217-' + serial);
      },
    }]);
  },
});
